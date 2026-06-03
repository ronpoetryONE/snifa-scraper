/**
 * Selectores CSS utilizados por el scraper para extraer elementos del HTML.
 */

/** Selector para los campos de metadata de la ficha de procedimiento */
export const FICHA_INFO_H4 = 'div.panel-body.sin-padding h4';

/** Selector para la unidad fiscalizable dentro de la ficha */
export const UNIDAD_FISCALIZABLE_CONTAINER = 'div.box-unidad-fiscalizable:has(h4:contains("Unidad fiscalizable"))';

/** Selector para el titular dentro de la ficha */
export const TITULAR_CONTAINER = 'div.box-unidad-fiscalizable:has(h4:contains("Titular"))';

/** Selector para las filas de la tabla de documentos en la ficha */
export const DOCUMENTO_FILA = '#documentos table.conBorde.tabla-resultado-busqueda tbody tr';
export const DOCUMENTO_NOMBRE = 'td[data-label="Nombre Documento"]';
export const DOCUMENTO_TIPO = 'td[data-label="Tipo Documento"]';
export const DOCUMENTO_FECHA = 'td[data-label="Fecha"]';
export const DOCUMENTO_LINK = 'td[data-label="Link"] a';
