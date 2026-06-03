# SNIFA Scraper

Scraper en TypeScript para la sección "Procedimientos Sancionatorios" del portal SNIFA de la SMA.

## Comandos

- `npm install`
- `npm run dev`
- `npm run build`
- `npm start`

## Requisitos

- Node.js 18+ o compatible
- npm

## Instalación

```bash
npm install
```

## Ejecutar en modo desarrollo

```bash
npm run dev
```

Esto ejecuta directamente `src/main.ts` con `tsx`.

## Ejecutar el scraper compilado

```bash
npm run build
npm start
```

## Salida

Los PDFs descargados se guardan en la carpeta `descargas/`.

## Notas

- El scraper usa `axios` para las peticiones HTTP y `cheerio` para parsear HTML.
- Se maneja el código `429 Too Many Requests` con reintentos y backoff.
- El comportamiento actual extrae expedientes y descarga los documentos asociados por expediente.

## Caso

Desafío de Scraping

Tu tarea es construir desde cero un scraper en TypeScript para la sección "Procedimientos Sancionatorios" del sitio público de SNIFA. El scraper debe:

- Recorrer el listado completo de expedientes disponibles.
- Abrir la ficha de cada expediente y extraer su metadata.
- Descargar los PDFs de los documentos asociados a cada expediente.
- Manejar correctamente los errores `429 Too Many Requests` con reintentos y backoff exponencial.
- Registrar los documentos que fallan para reintentar posteriormente.

El proyecto evita navegadores automatizados y usa `axios` + `cheerio` para peticiones HTTP y parseo HTML.
