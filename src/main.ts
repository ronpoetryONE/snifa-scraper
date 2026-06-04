/**
 * Scraper automatizado para el portal SNIFA (snifa.sma.gob.cl).
 *
 * Extrae expedientes sancionatorios del sistema gubernamental chileno
 * y descarga todos los documentos PDF asociados a cada expediente.
 *
 * Manejo de Rate Limit:
 * - El servidor impone un limite estricto de ~5 peticiones por ventana de 60s.
 * - Se utiliza Keep-Alive para reutilizar conexiones TCP y extender el umbral.
 * - Ante un HTTP 429, se respeta el header Retry-After del servidor.
 */

import axios, { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { DocumentoExpediente, Expediente, FailedDownloadRecord } from './types.js';
import {
    DOCUMENTO_FILA,
    DOCUMENTO_NOMBRE,
    DOCUMENTO_TIPO,
    DOCUMENTO_FECHA,
    DOCUMENTO_LINK,
    FICHA_INFO_H4,
    UNIDAD_FISCALIZABLE_CONTAINER,
    TITULAR_CONTAINER
} from './selectors.js';

const BASE_URL = 'https://snifa.sma.gob.cl';
const OUTPUT_DIR = path.join(process.cwd(), 'descargas');
const FAILED_DOWNLOADS_DIR = path.join(OUTPUT_DIR, 'failed-downloads');
const FAILED_DOWNLOADS_FILE = path.join(FAILED_DOWNLOADS_DIR, 'failed-downloads.json');
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let failedDownloads: FailedDownloadRecord[] = [];

const writeFailedDownloads = () => {
    if (!fs.existsSync(FAILED_DOWNLOADS_DIR)) {
        fs.mkdirSync(FAILED_DOWNLOADS_DIR, { recursive: true });
    }

    fs.writeFileSync(FAILED_DOWNLOADS_FILE, JSON.stringify(failedDownloads, null, 2), 'utf-8');
};

const appendFailedDownload = (record: FailedDownloadRecord) => {
    failedDownloads.push(record);
    writeFailedDownloads();
};

/**
 * Sanitiza nombres de archivo eliminando caracteres no válidos y
 * reemplazando espacios por guiones bajos.
 */
const sanitizeFileName = (value: string) =>
    value
        .normalize('NFKD')
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
        .replace(/[^a-zA-Z0-9._\- ]+/g, '')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '')
        .trim();

/**
 * Extrae el nombre de archivo real desde el header Content-Disposition.
 * Soporta filename* con codificación UTF-8 y filename simple.
 */
const getFilenameFromContentDisposition = (header?: string): string | null => {
    if (!header) {
        return null;
    }

    const filenameStarMatch = header.match(/filename\*=(?:UTF-8'')?\s*([^\s;]+)/i);
    if (filenameStarMatch) {
        try {
            return decodeURIComponent(filenameStarMatch[1].replace(/^['"]|['"]$/g, ''));
        } catch {
            return filenameStarMatch[1].replace(/^['"]|['"]$/g, '');
        }
    }

    const filenameMatch = header.match(/filename\s*=\s*['"]?([^'";]+)['"]?/i);
    if (filenameMatch) {
        return filenameMatch[1].trim();
    }

    return null;
};

/** Agente HTTPS persistente: reutiliza la conexion TCP para reducir handshakes TLS */
const httpsAgent = new https.Agent({ keepAlive: true });

type RetryableAxiosError = AxiosError & { attempts?: number };

/**
 * Ejecuta una peticion HTTP con reintentos automaticos ante Rate Limit (429).
 *
 * Cuando el servidor responde con 429, lee el header "Retry-After" para
 * determinar el tiempo exacto de espera antes de reintentar.
 * El backoff se duplica en cada reintento fallido consecutivo.
 *
 * @param config - Configuracion de Axios (method, url, headers, data, etc.)
 * @param retries - Cantidad maxima de reintentos permitidos
 * @param delay - Tiempo base de espera en ms si no existe header Retry-After
 * @returns La respuesta HTTP exitosa
 * @throws El error original si se agotan los reintentos o no es un 429
 */
async function requestWithRetry(config: AxiosRequestConfig, retries = 5, delay = 5000, attempt = 1): Promise<AxiosResponse> {
    try {
        return await axios({
            ...config,
            httpsAgent,
            timeout: 60000,
            headers: {
                ...config.headers,
                'User-Agent': USER_AGENT,
                'Connection': 'keep-alive'
            }
        });
    } catch (error: unknown) {
        const axiosError = axios.isAxiosError(error) ? error : null;

        if (axiosError?.response?.status === 429 && retries > 0) {
            const retryAfterStr = axiosError.response.headers['retry-after'];
            let waitTime = delay;
            if (retryAfterStr) {
                const retryAfterSec = parseInt(String(retryAfterStr), 10);
                if (!isNaN(retryAfterSec)) {
                    waitTime = (retryAfterSec + 1) * 1000;
                }
            }

            console.warn(`[429 Too Many Requests] - Reintentando en ${waitTime / 1000}s... (${retries} intentos restantes)`);
            await sleep(waitTime);
            return requestWithRetry(config, retries - 1, delay * 2, attempt + 1);
        }

        if (retries > 0 && (!axiosError?.response || (axiosError.response.status >= 500 && axiosError.response.status < 600))) {
            console.warn(`[${axiosError?.response?.status ?? 'NETWORK'}] - Reintentando en ${delay / 1000}s... (${retries} intentos restantes)`);
            await sleep(delay);
            return requestWithRetry(config, retries - 1, delay * 2, attempt + 1);
        }

        if (axiosError) {
            const retryError = axiosError as RetryableAxiosError;
            retryError.attempts = attempt;
        }

        throw error;
    }
}

/**
 * Consulta la tabla paginada de expedientes sancionatorios del portal SNIFA.
 *
 * Envia un POST al endpoint ObtenerResultadosGrid simulando la paginacion
 * del DataTable del frontend. Parsea cada fila para extraer el ID numerico,
 * el codigo ROL y el estado procesal del expediente.
 *
 * @param start - Indice de inicio para la paginacion (0-based)
 * @param length - Cantidad de expedientes a solicitar en este lote
 * @returns Objeto con el total de registros y la lista de expedientes parseados
 */
async function obtenerExpedientes(start: number, length: number): Promise<{ total: number; lista: Expediente[] }> {
    const url = `${BASE_URL}/Sancionatorio/ObtenerResultadosGrid`;

    const params = new URLSearchParams();
    params.append('draw', '1');
    params.append('start', start.toString());
    params.append('length', length.toString());

    const response = await requestWithRetry({
        method: 'POST',
        url,
        data: params.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const data = response.data;
    const lista: Expediente[] = data.data.map((fila: string[]) => {
        const rol = fila[1];
        const estado = fila[6];
        const linkHtml = fila[7];

        const match = linkHtml.match(/\/Sancionatorio\/Ficha\/(\d+)/);
        const id = match ? match[1] : '';

        return { id, rol, estado, documentos: [] };
    }).filter((exp: Expediente) => exp.id !== '');

    return { total: data.recordsTotal, lista };
}

/**
 * Procesa un expediente individual: accede a su ficha HTML, extrae metadata
 * adicional y descarga los documentos asociados en una carpeta propia.
 *
 * Cada archivo se nombra con el patron: {ROL}_{indice}_{documento}_{docId}.pdf
 * donde ROL tiene las barras reemplazadas por guiones para compatibilidad
 * con el sistema de archivos.
 *
 * @param expediente - Objeto con id, rol y estado del expediente a procesar
 */
async function procesarFicha(expediente: Expediente) {
    const url = `${BASE_URL}/Sancionatorio/Ficha/${expediente.id}`;
    console.log(`\nAnalizando ficha del Expediente ROL: ${expediente.rol} (ID: ${expediente.id})`);

    const response = await requestWithRetry({ method: 'GET', url });
    const $ = cheerio.load(response.data);

    const extractFichaCampo = (label: string) =>
        $(FICHA_INFO_H4)
            .filter((_, element) => $(element).text().includes(label))
            .find('i')
            .text()
            .trim();

    const extractContainerText = (containerSelector: string) => {
        const container = $(containerSelector).first();
        if (!container.length) {
            return '';
        }

        const clone = container.clone();
        clone.find('h4').remove();
        return clone
            .text()
            .replace(/\s+/g, ' ')
            .trim();
    };

    expediente.fechaInicio = extractFichaCampo('Fecha Inicio');
    expediente.fechaTermino = extractFichaCampo('Fecha Término');
    expediente.estado = extractFichaCampo('Estado') || expediente.estado;
    expediente.unidadFiscalizable = extractContainerText(UNIDAD_FISCALIZABLE_CONTAINER);
    expediente.titular = extractContainerText(TITULAR_CONTAINER);

    const documentos: DocumentoExpediente[] = [];
    $(DOCUMENTO_FILA).each((_, row) => {
        const rowElement = $(row);
        const nombre = rowElement.find(DOCUMENTO_NOMBRE).text().trim();
        const tipo = rowElement.find(DOCUMENTO_TIPO).text().trim();
        const fecha = rowElement.find(DOCUMENTO_FECHA).text().trim();
        const href = rowElement.find(DOCUMENTO_LINK).attr('href') || '';

        if (!nombre || !href) {
            return;
        }

        documentos.push({ nombre, tipo, fecha, href });
    });

    expediente.documentos = documentos;

    const carpetaExpediente = path.join(OUTPUT_DIR, expediente.rol.replace(/\//g, '-'));
    if (!fs.existsSync(carpetaExpediente)) {
        fs.mkdirSync(carpetaExpediente, { recursive: true });
    }

    const metadataRuta = path.join(carpetaExpediente, 'metadata.json');
    fs.writeFileSync(metadataRuta, JSON.stringify({
        id: expediente.id,
        rol: expediente.rol,
        estado: expediente.estado,
        fechaInicio: expediente.fechaInicio,
        fechaTermino: expediente.fechaTermino,
        unidadFiscalizable: expediente.unidadFiscalizable,
        titular: expediente.titular,
        documentos: expediente.documentos
    }, null, 2), 'utf-8');

    console.log(`Se encontraron ${documentos.length} documentos para el expediente ${expediente.rol}`);
    if (!fs.existsSync(carpetaExpediente)) {
        fs.mkdirSync(carpetaExpediente, { recursive: true });
    }

    for (const [index, documento] of documentos.entries()) {
        let docUrl = '';
        let rutaDestino = '';

        try {
            docUrl = `${BASE_URL}${documento.href}`;
            const docId = documento.href.split('/').pop() || `unknown-${index + 1}`;
            const safeName = sanitizeFileName(documento.nombre || `documento_${index + 1}`);
            const nombreArchivo = `${expediente.rol.replace(/\//g, '-')}_${index + 1}_${safeName}_${docId}.pdf`;
            rutaDestino = path.join(carpetaExpediente, nombreArchivo);

            console.log(`  Descargando: ${nombreArchivo}`);

            const downloadResponse = await requestWithRetry({
                method: 'GET',
                url: docUrl,
                responseType: 'stream'
            });

            const contentDisposition = downloadResponse.headers?.['content-disposition'];
            const realFilename = getFilenameFromContentDisposition(contentDisposition);
            const outputFilename = realFilename ? sanitizeFileName(realFilename) : nombreArchivo;
            rutaDestino = path.join(carpetaExpediente, outputFilename);

            /** Escribe el stream directamente al disco sin cargar el PDF en memoria */
            const writer = fs.createWriteStream(rutaDestino);
            downloadResponse.data.pipe(writer);

            await new Promise<void>((resolve, reject) => {
                writer.on('finish', () => resolve());
                writer.on('error', reject);
            });

            if (index < documentos.length - 1) {
                await sleep(200);
            }

        } catch (error: unknown) {
            const axiosError = axios.isAxiosError(error) ? error : null;
            const errorMessage = axiosError?.message ?? (error instanceof Error ? error.message : String(error));
            const retryErr = axiosError as RetryableAxiosError | null;
            const attempts: number = typeof retryErr?.attempts === 'number' ? retryErr.attempts! : 1;
            console.error(`  Error al descargar documento ${documento.href}:`, errorMessage);

            const failedRecord: FailedDownloadRecord = {
                timestamp: new Date().toISOString(),
                expedienteId: expediente.id,
                rol: expediente.rol,
                documentoNombre: documento.nombre,
                documentoTipo: documento.tipo,
                documentoFecha: documento.fecha,
                documentoHref: documento.href,
                docUrl,
                rutaDestino,
                errorMessage,
                attempts,
                status: 'failed'
            };

            appendFailedDownload(failedRecord);
        }
    }
}

/**
 * Punto de entrada principal del scraper.
 *
 * 1. Crea el directorio de descargas si no existe.
 * 2. Obtiene el total de expedientes disponibles en SNIFA.
 * 3. Solicita y procesa los expedientes en bloques de 100 para evitar errores 500.
 * 4. Introduce una pausa de 1.5s entre expedientes como cortesia al servidor.
 *
 * El metadata de cada expediente se guarda antes de descargar documentos,
 * de modo que la ejecución puede detenerse y retomarse sin perder la ficha.
 */
async function main() {
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    if (!fs.existsSync(FAILED_DOWNLOADS_DIR)) {
        fs.mkdirSync(FAILED_DOWNLOADS_DIR, { recursive: true });
    }

    try {
        console.log('Iniciando Scraper de SNIFA...');

        // 1. Obtener la cantidad total de registros disponibles consultando un solo elemento
        const initial = await obtenerExpedientes(0, 1);
        const total = initial.total;
        console.log(`Total de expedientes en el sistema: ${total}. Procesando en bloques paginados...`);

        // Tamaño estandar de lote para que el backend IIS/ASP.NET responda correctamente
        const LOTE_SIZE = 100;

        // 2. Iterar sobre los datos solicitando fragmentos especificos
        for (let start = 0; start < total; start += LOTE_SIZE) {
            console.log(`\n--- Cargando lote de expedientes desde el indice ${start} (Tamaño: ${LOTE_SIZE}) ---`);
            
            const { lista } = await obtenerExpedientes(start, LOTE_SIZE);

            // 3. Procesar los expedientes devueltos en el lote actual
            for (const expediente of lista) {
                await procesarFicha(expediente);
                await sleep(1500); // Retardo entre consultas individuales de ficha
            }

            // Pausa breve de cortesia al finalizar cada bloque completo antes de pedir el siguiente
            await sleep(3000);
        }

        console.log('\nProceso finalizado con exito.');
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('\nError critico en la ejecucion del Scraper:', errorMessage);
    }
}

main();