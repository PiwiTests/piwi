Esta traducción al español es un borrador: todavía no la ha revisado ningún hablante nativo. Si ves un error o una frase poco natural, [sugiere una corrección](https://github.com/PiwiTests/platform/issues/new?template=translation.yml).

Piwi Picker te da el locator de Playwright que hay que usar para cualquier elemento de la página que estás viendo. Cada candidato se puntúa según su estabilidad y luego se ejecuta en la página tal como está, para que el primero encuentre exactamente un elemento. Recorre un flujo clic a clic y la extensión escribe la prueba; reproduce un bug y escribe la prueba que falla y el informe.

**Desde el botón de la barra de herramientas, en cualquier página**

- **Elegir un elemento**: los locators clasificados de un elemento, comprobados de nuevo en la página, para copiarlos solos, como línea de acción o como aserción. Cuando varios elementos comparten un nombre, limita el locator a un elemento padre estable.
- **Grabar acciones**: clics, textos escritos y opciones elegidas en las páginas de un sitio, convertidos en una prueba de TypeScript lista para ejecutarse. Las contraseñas nunca se graban.
- **Informar de un bug**: graba los pasos, marca lo que está mal en la página y obtén una prueba que falla, un informe en Markdown y un archivo .piwibug con los errores de la consola y las peticiones fallidas. **Reproducir un informe de bug** vuelve a ejecutar sus pasos en una pestaña.
- **Revisión**: los elementos que ningún locator estable encuentra por sí solo, cada uno con un data-testid sugerido.
- **Multiselección**, **Aserciones** y **Contexto para IA**: el patrón común a las filas de una lista, líneas expect(...) para un elemento y un bloque sobre un elemento para un agente de código.

**En las DevTools del navegador**

Los locators clasificados del elemento seleccionado en Elementos, una consola de locators con el veredicto del modo estricto, los elementos a los que pones nombre exportados como page object, mocks de red, una petición ralentizada o fallida, el viewport de un proyecto de Playwright y Guardar la sesión para las pruebas.

**Privado de forma predeterminada**

Elegir elementos y grabar nunca usan la red. No se recopila nada, no se envía nada.

**Opcional: conectar tu propia instancia de Piwi**

Piwi es un panel de control autoalojado para los resultados de Playwright. Conectada a tu instancia (su dirección y una clave de API, en la configuración), la extensión además resalta los elementos de la página que alcanzan tus pruebas, indica cuáles de tus funciones de prueba funcionan en ella y graba los flujos como llamadas a esas funciones. Lee tu instancia y solo le envía una cosa: un informe de bug, cuando haces clic en Enviar en la vista previa que muestra exactamente lo que se envía.

**Permisos**

- La pestaña que estás viendo, solo cuando haces clic en el botón de la extensión o usas el atajo de teclado.
- Un solo sitio, que se pide cuando empiezas a grabar en él, para seguir tus acciones de una página a otra. No se concede nada al instalar la extensión.
- Las cookies de ese sitio, que se piden solo cuando guardas su sesión para tus pruebas: van a un archivo en tu máquina.
- La dirección de tu instancia de Piwi, que se pide cuando guardas una conexión.

Piwi Picker habla inglés, francés, alemán, español y portugués de Brasil.

Documentación (en inglés): [piwitests.dev/features/extension](https://piwitests.dev/features/extension)

Piwi no está afiliado a Microsoft Corporation, ni cuenta con su aprobación o respaldo. Playwright es una marca comercial de Microsoft Corporation.
