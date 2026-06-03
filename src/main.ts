/**
 * Scraper automatizado para el portal SNIFA (snifa.sma.gob.cl).
 *
 * Extrae expedientes sancionatorios del sistema gubernamental chileno
 * y descarga todos los documentos PDF asociados a cada expediente.
 *
 * Manejo de Rate Limit:
 *   - El servidor impone un limite estricto de ~5 peticiones por ventana de 60s.
 *   - Se utiliza Keep-Alive para reutilizar conexiones TCP y extender el umbral.
 *   - Ante un HTTP 429, se respeta el header Retry-After del servidor.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { Expediente } from './types.js';

const BASE_URL = 'https://snifa.sma.gob.cl';
const OUTPUT_DIR = path.join(process.cwd(), 'descargas');
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Agente HTTPS persistente: reutiliza la conexion TCP para reducir handshakes TLS */
const httpsAgent = new https.Agent({ keepAlive: true });

/** Contador global de peticiones realizadas durante la ejecucion */
let globalRequestCount = 0;

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
async function requestWithRetry(config: any, retries = 5, delay = 5000): Promise<any> {
    globalRequestCount++;

    try {
        return await axios({
            ...config,
            httpsAgent,
            timeout: 15000,
            headers: {
                ...config.headers,
                'User-Agent': USER_AGENT,
                'Connection': 'keep-alive'
            }
        });
    } catch (error: any) {
        if (error.response && error.response.status === 429 && retries > 0) {
            const retryAfterStr = error.response.headers['retry-after'];
            let waitTime = delay;
            if (retryAfterStr) {
                const retryAfterSec = parseInt(retryAfterStr, 10);
                if (!isNaN(retryAfterSec)) {
                    waitTime = (retryAfterSec + 1) * 1000;
                }
            }

            console.warn(`[429 Too Many Requests] - Reintentando en ${waitTime / 1000}s... (${retries} intentos restantes)`);
            await sleep(waitTime);
            return requestWithRetry(config, retries - 1, delay * 2);
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

        return { id, rol, estado };
    }).filter((exp: Expediente) => exp.id !== '');

    return { total: data.recordsTotal, lista };
}

/**
 * Procesa un expediente individual: accede a su ficha HTML, extrae los
 * enlaces de descarga y persiste cada documento PDF en el disco local.
 *
 * Cada archivo se nombra con el patron: {ROL}_doc_{indice}_{docId}.pdf
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

    const enlacesDocs: string[] = [];
    $('a[href^="/General/Descargar/"]').each((_, element) => {
        const href = $(element).attr('href');
        if (href) {
            enlacesDocs.push(href);
        }
    });

    console.log(`Se encontraron ${enlacesDocs.length} documentos para el expediente ${expediente.rol}`);

    for (const [index, href] of enlacesDocs.entries()) {
        try {
            const docUrl = `${BASE_URL}${href}`;
            const docId = href.split('/').pop();
            const nombreArchivo = `${expediente.rol.replace(/\//g, '-')}_doc_${index + 1}_${docId}.pdf`;
            const rutaDestino = path.join(OUTPUT_DIR, nombreArchivo);

            console.log(`  Descargando: ${nombreArchivo}`);

            const downloadResponse = await requestWithRetry({
                method: 'GET',
                url: docUrl,
                responseType: 'stream'
            });

            /** Escribe el stream directamente al disco sin cargar el PDF en memoria */
            const writer = fs.createWriteStream(rutaDestino);
            downloadResponse.data.pipe(writer);

            await new Promise<void>((resolve, reject) => {
                writer.on('finish', () => resolve());
                writer.on('error', reject);
            });

            if (index < enlacesDocs.length - 1) {
                await sleep(200);
            }

        } catch (err: any) {
            console.error(`  Error al descargar documento ${href}:`, err.message);
        }
    }
}

/**
 * Punto de entrada principal del scraper.
 *
 * 1. Crea el directorio de descargas si no existe.
 * 2. Obtiene el total de expedientes disponibles en SNIFA.
 * 3. Solicita la lista completa y procesa cada uno secuencialmente.
 * 4. Introduce una pausa de 1.5s entre expedientes como cortesia al servidor.
 */
async function main() {
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    try {
        console.log('Iniciando Scraper de SNIFA...');

        const initial = await obtenerExpedientes(0, 1);
        const total = initial.total;
        const { lista } = await obtenerExpedientes(0, total);
        console.log(`Total de expedientes en el sistema: ${total}. Procesando todos...`);

        for (const expediente of lista) {
            await procesarFicha(expediente);
            await sleep(1500);
        }

        console.log('\nProceso finalizado con exito.');
    } catch (error: any) {
        console.error('\nError critico en la ejecucion del Scraper:', error.message);
    }
}

main();