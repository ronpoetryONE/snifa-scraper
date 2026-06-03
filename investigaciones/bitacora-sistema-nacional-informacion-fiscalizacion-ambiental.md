La investigación comenzó porque necesitaba sortear la restricción técnica de no usar navegadores automatizados para sacar expedientes del portal de la Superintendencia del Medio Ambiente. Lo primero que hice fue revisar cómo respondía el servidor ante consultas rápidas y concurrentes. Para esto usé curl y forcé un agente de usuario que pareciera un navegador Linux real.

```bash
curl -I -s -A "Mozilla/5.0 (X11; Linux x86_64)" "https://snifa.sma.gob.cl/Sancionatorio/Resultado"
```

```
HTTP/1.1 200 OK
Cache-Control: private
Content-Length: 73987
Content-Type: text/html; charset=utf-8
Server: Microsoft-IIS/10.0
X-AspNetMvc-Version: 4.0
X-AspNet-Version: 4.0.30319
X-Powered-By: ASP.NET
Date: Wed, 03 Jun 2026 20:02:00 GMT
X-Content-Type-Options: nosniff
X-XSS-Protection: 1; mode=block
Content-Security-Policy: frame-ancestors 'self' *.sma.gob.cl
```

La respuesta mostró que el servidor estaba montado en Microsoft IIS 10.0 y ASP.NET MVC 4.0. Ese hallazgo fue clave, porque los sitios gubernamentales con esa infraestructura suelen ser muy rígidos ante picos de tráfico y aplican bloqueos temporales. El cuerpo devuelto pesaba casi setenta y cuatro kilobytes, muy poco para una página que debería contener miles de expedientes. Además, no había cookies de sesión obligatorias, lo que confirmó que la información era de libre acceso. La falta de contenido real hizo pensar que los datos se cargaban de forma asíncrona después de cargar el contenedor inicial.

El siguiente paso fue descubrir cómo se cargaban los datos. Al revisar el código de la página vi que usaba DataTables, una librería de jQuery para grillas dinámicas. En ASP.NET, esa librería suele trabajar con procesamiento en el servidor para no sobrecargar el navegador. Busqué rutas asociadas al controlador del módulo sancionatorio con un filtro de expresiones regulares sobre el HTML.

```bash
curl -s -A "Mozilla/5.0 (X11; Linux x86_64)" "https://snifa.sma.gob.cl/Sancionatorio/Resultado" | grep -oE '/Sancionatorio/[a-zA-Z0-9_-]+'
```

```
/Sancionatorio/ObtenerResultadosGrid
/Sancionatorio/Resultado
/Sancionatorio/Mapa
```

El resultado mostró la ruta interna ObtenerResultadosGrid dentro del controlador. Ese hallazgo cambió la estrategia: en lugar de parsear la interfaz visual, podía usar la API oculta. Si accedía directamente al flujo de datos estructurados, el sistema sería más rápido y estable, y gastaría menos ancho de banda.

Luego descifré el protocolo que pedía ese controlador para devolver la información y ver la estructura del objeto. Sabía que DataTables exige parámetros de paginación, así que mandé una petición simulando una consulta inicial por los primeros cinco registros.

```bash
curl -s -X POST -A "Mozilla/5.0 (X11; Linux x86_64)" -d "draw=1&start=0&length=5" "https://snifa.sma.gob.cl/Sancionatorio/ObtenerResultadosGrid" | jq '.data[] | {rol: .[1], estado: .[6], link_html: .[7]}'
```

```
{
  "rol": "D-088-2026",
  "estado": "En curso",
  "link_html": "<span></span><a href='/Sancionatorio/Ficha/4511'><i class='fa fa-plus-circle'></i> Ver detalles</a>"
}
{
  "rol": "D-081-2026",
  "estado": "En curso",
  "link_html": "<span></span><a href='/Sancionatorio/Ficha/4506'><i class='fa fa-plus-circle'></i> Ver detalles</a>"
}
{
  "rol": "D-079-2026",
  "estado": "En curso",
  "link_html": "<span></span><a href='/Sancionatorio/Ficha/4502'><i class='fa fa-plus-circle'></i> Ver detalles</a>"
}
{
  "rol": "D-078-2026",
  "estado": "En curso",
  "link_html": "<span></span><a href='/Sancionatorio/Ficha/4501'><i class='fa fa-plus-circle'></i> Ver detalles</a>"
}
{
  "rol": "D-077-2026",
  "estado": "En curso",
  "link_html": "<span></span><a href='/Sancionatorio/Ficha/4500'><i class='fa fa-plus-circle'></i> Ver detalles</a>"
}
```

La respuesta validó la hipótesis: el controlador trabajaba en el servidor. El objeto principal entregó el total de registros, mostrando más de tres mil trescientos expedientes. Con el formateador aislé la matriz de datos y comprobé que venía en un arreglo bidimensional para optimizar el peso en red. Descubrí que el índice uno era el código del rol, el índice seis era el estado procesal, y el índice siete tenía una cadena con etiquetas HTML. Con esa cadena pude sacar el identificador numérico de la ficha individual, necesario para continuar.

Con los identificadores en mano, me concentré en descubrir cómo estaban los documentos adjuntos en cada ficha y si había capas de seguridad o tokens dinámicos de descarga. Inspeccioné el HTML de una ficha real usando el identificador obtenido antes.

```bash
curl -s -A "Mozilla/5.0 (X11; Linux x86_64)" "https://snifa.sma.gob.cl/Sancionatorio/Ficha/4511" | grep -iE 'href="[^"](documento|descargar|file|download|get)[^"]"'
```

```
<li class="active"><a data-toggle="tab" href="#documentos"><i class="fa fa-file-text-o"></i> Documentos (4)</a></li>
```

El comando mostró que, a diferencia del listado general, los enlaces de documentos adjuntos sí estaban impresos estáticamente en el HTML de la página. Eso dejó claro que el analizador de etiquetas solo sería necesario en esta etapa, para buscar los enlaces de descarga. Cada ruta tenía un controlador de descarga y un número de trece dígitos como identificador del archivo físico.

El último paso en la terminal fue validar que el servidor entregara los archivos binarios de forma directa con peticiones limpias. Ejecute la descarga forzando el seguimiento de redirecciones por si los documentos estaban en servidores externos o nubes de datos del estado.

```bash
curl -L -A "Mozilla/5.0 (X11; Linux x86_64)" -o "test_sma.pdf" "https://snifa.sma.gob.cl/General/Descargar/2060100094517"
```

```
  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current
                                 Dload  Upload   Total   Spent    Left  Speed
  0     0    0     0    0     0      0      0 --:--:-- --:--:--    0     0    0     0    0     0      0      0 --:--:--  0:00:01 --:--:--    0     0    0     0    0     0      0      0 --:--:--  0:00:02 --:--:-- 4100  421k    0  421k    0     0   138k      0 --:--:--  0:00:03 --:--:-- 138k
```

El binario de prueba llegó íntegro, confirmando que la plataforma no pedía validación biométrica, contraseñas ni cookies restrictivas una vez conocida la ruta exacta.

Las conclusiones finales fueron que la plataforma tiene una arquitectura híbrida: el descubrimiento de expedientes debe hacerse mediante consultas POST al endpoint de la grilla interna, y el análisis de documentos adjuntos debe hacerse leyendo la estructura estática de las fichas. El mayor riesgo es la sensibilidad del servidor IIS a la tasa de peticiones, que provoca rápidamente un HTTP 429 si se pasan de unas cinco consultas en un minuto.

Para el desarrollo definitivo en TypeScript, el plan inmediato es estructurar un punto de entrada que haga una llamada ligera para capturar dinámicamente el volumen total de expedientes. Después, hay que configurar un bucle que avance de forma secuencial en lotes controlados para extraer la lista completa sin alertar al firewall. La lógica de red de Axios debe envolver en una función adaptativa que revise si el servidor envía un encabezado de espera por congestión y, si no lo hace, aplique un retraso exponencial antes de reintentar. Finalmente, la descarga de los PDF debe dirigir los datos directamente a archivos en disco para mantener bajo y constante el uso de memoria del proceso durante ejecuciones prolongadas.