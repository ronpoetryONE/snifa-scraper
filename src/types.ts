/**
 * Información de un documento asociado a un expediente.
 */
export interface DocumentoExpediente {
    /** Nombre visible del documento en la tabla de la ficha */
    nombre: string;

    /** Tipo de documento según se muestra en la ficha */
    tipo: string;

    /** Fecha asociada al documento en la ficha */
    fecha: string;

    /** Ruta relativa de descarga dentro del portal SNIFA */
    href: string;
}

/**
 * Estructura de datos que representa un expediente sancionatorio
 * obtenido del portal SNIFA.
 */
export interface Expediente {
    /** Identificador unico asignado internamente al expediente */
    id: string;
    
    /** Codigo del rol del expediente (ej: D-088-2026) */
    rol: string;
    
    /** Estado procesal actual del expediente (ej: En curso, Resuelto) */
    estado: string;

    /** Fecha de inicio del procedimiento, tomada de la ficha */
    fechaInicio?: string;

    /** Fecha de termino del procedimiento, tomada de la ficha */
    fechaTermino?: string;

    /** Unidad fiscalizable asociada al expediente */
    unidadFiscalizable?: string;

    /** Titular del expediente */
    titular?: string;

    /** Lista de documentos asociados al expediente */
    documentos: DocumentoExpediente[];
}
