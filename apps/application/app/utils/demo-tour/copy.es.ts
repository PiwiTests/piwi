import type { TourCopy } from './copy';

/**
 * The guided tour in Spanish, with exactly the keys of the English (`copy.en.ts`).
 * A `**bold**` dashboard label stays in English, as the screen spells it. The
 * reader is «tú»; a question or an exclamation opens with ¿ or ¡.
 */
export const ES_COPY = {
  ui: {
    launch: 'Visita guiada',
    launchTitle: 'Elige tu rol y descubre las pantallas que más usarías',
    promptTitle: '¿Hacemos una visita guiada?',
    promptBody:
      'Elige tu rol y la visita te mostrará las pantallas que más usarías, con los datos de ejemplo de esta demo.',
    roles: 'Tu rol',
    stopCount: '{count} paradas',
    later: 'Más tarde',
    dismiss: 'No volver a mostrar',
    language: 'Idioma',
    next: 'Siguiente',
    back: 'Anterior',
    done: 'Terminar',
    progress: '{{current}} de {{total}}',
    close: 'Salir de la visita',
    docs: 'Documentación (en inglés)',
    finishedTitle: 'Fin de la visita',
    finishedBody: 'Las visitas de los demás roles están en «Visita guiada», en la barra superior.',
  },
  profiles: {
    developer: {
      label: 'Desarrollo',
      hint: 'Entender un fallo y arreglarlo',
      stops: {
        failure: {
          title: 'Un fallo, leído de arriba abajo',
          body: 'Cada ejecución fallida se abre en este bloque. El titular dice qué falló, **Most likely** da la causa que señalan las evidencias y **Next**, el único paso a seguir: aquí, aplicar el parche que escribió el diagnóstico de IA del grupo de fallos.',
        },
        evidence: {
          title: 'Las evidencias, guardadas tras la CI',
          body: 'Lo que el run capturó de esta ejecución, una pestaña por vista: los pasos, las peticiones y la consola en una misma línea de tiempo, la página en el momento del fallo, el código de la prueba. Un punto marca cada pestaña que cita **Most likely**.',
        },
        locator: {
          title: 'El localizador que deberías haber usado',
          body: "Cuando un localizador se rompe, como aquí getByRole('button') al encontrar tres botones, Piwi ordena reemplazos capturados en el último run en que la prueba pasó. Copia el recomendado o haz clic en el elemento de la página fallida con **Pick from snapshot**.",
        },
        diagnosis: {
          title: 'Un diagnóstico de IA, contrastado con tu código',
          body: 'Con un proveedor de IA configurado, Piwi diagnostica un grupo de fallos a partir de sus evidencias y de los commits desde su último éxito. Este atribuye las 51 filas de la tabla de usuarios al tamaño de página por defecto de la API y propone este parche, marcado **Applies cleanly** sobre el código. Desde entonces llegó una corrección, y se mantiene.',
        },
        coverage: {
          title: 'Las líneas del servidor que ejecutó esta prueba',
          body: 'Cuando un proyecto registra la cobertura, la pestaña **Source** lista el código que ejecutó una prueba. Esta prueba fallida ejecutó cinco archivos de la API ASP.NET Core, primero los endpoints de usuarios con las líneas sospechosas; abre uno para leer las líneas que ejecutó. El enlace **tests** de un archivo abre todas las pruebas que lo ejecutan, línea por línea.',
        },
        mcp: {
          title: 'Pregunta desde tu editor',
          body: 'Piwi también es un servidor MCP: Claude Code, Cursor o Copilot en VS Code pueden leer los grupos de fallos, sus evidencias y sus planes de corrección, y hacer su triaje sin salir del editor. **Client setup** tiene la configuración de cada cliente; el endpoint de esta demo no está activo.',
        },
        simulate: {
          title: 'Mira cómo llega un run',
          body: '**Simulate a test run** envía un run nuevo a la demo, como lo hace el reporter desde la CI. En **Run with failures**, dos timeouts se suman al grupo del primer fallo que viste, y un error nuevo abre un grupo propio.',
        },
      },
    },
    qa: {
      label: 'QA / pruebas',
      hint: 'Pruebas inestables, lentas o que faltan',
      stops: {
        inbox: {
          title: 'Los fallos, agrupados por causa',
          body: 'La **Failure inbox** lista todos los grupos de fallos abiertos de los proyectos: una fila por causa raíz, sin importar a cuántas pruebas afecte. Resuelve, asigna, pospón o pon en cuarentena una fila desde el teclado, y la decisión vale para todas sus pruebas.',
        },
        flaky: {
          title: 'Pruebas inestables, ordenadas por lo que cuestan',
          body: 'Las pruebas que fallan y luego pasan, ordenadas por el tiempo de CI que desperdician sus reintentos, cada una con una puntuación de 0 a 100 según sus reintentos y alternancias, y su principal sospechoso. **Quarantine** mantiene una prueba en ejecución y con resultados, pero el control de la CI la ignora.',
        },
        suspects: {
          title: 'Qué la vuelve inestable',
          body: 'Piwi compara las ejecuciones fallidas y exitosas de esta prueba durante 30 días y ordena lo que distingue a los fallos. Primero aparece una API de carrito lenta, y retrasarla en el Flake Lab reprodujo el fallo 3 de cada 4 veces.',
        },
        slow: {
          title: 'Las pruebas que frenan la suite',
          body: '**Slowest tests** ordena las pruebas del proyecto por duración media en los últimos runs, con su peor tiempo y el último. Las pruebas de pago con tarjeta y con PayPal aparecen como más lentas: sus últimos runs llegan al límite de 30 s.',
        },
        lab: {
          title: 'Probar una corrección antes de liberar una prueba',
          body: 'El Flake Lab vuelve a ejecutar una prueba inestable bajo cada condición sospechosa, junto a un control, y otra vez tras la corrección. «Table pagination works correctly» está **Verified fixed**: con el retraso que la reproducía, la corrección aguantó 5 de 5 veces, así que se propone sacarla de cuarentena.',
        },
        gaps: {
          title: 'Lo que tus pruebas no cubren',
          body: 'El Test Map dibuja las funciones de la aplicación a partir de lo que alcanzan las pruebas y lista las pruebas que aún no existen, ordenadas por exposición. Una de ellas: las pruebas siguen pasando cuando POST /api/orders falla.',
        },
        combined: {
          title: 'Todas las suites, una sola tasa',
          body: 'Las pruebas unitarias de ambos lados y la ejecución de Playwright de un mismo commit, contadas sobre las mismas líneas: **Combined coverage** da la parte que ejecutan juntas, luego la de cada suite y las líneas que solo ejecutan las pruebas unitarias.',
        },
      },
    },
    product: {
      label: 'Product owner',
      hint: 'Evolución de la calidad e informes',
      stops: {
        health: {
          title: 'Todos los proyectos de un vistazo',
          body: '**Project health** muestra de cada proyecto sus últimos 20 runs, su tendencia y la tasa de éxito de su último run, con los proyectos que fallan primero. Abre uno para ver qué falló.',
        },
        analytics: {
          title: 'La calidad a lo largo del tiempo',
          body: 'Los **Headline numbers** de todos los proyectos en los últimos 30 días, frente a los 30 anteriores: tasas de éxito, pruebas inestables, minutos de CI desperdiciados, causas de fallo abiertas, tiempo de corrección. Cuando un proyecto fija un objetivo, la tarjeta indica cuántos lo cumplen.',
        },
        dashboards: {
          title: 'Un panel por equipo',
          body: 'Además de los paneles integrados, un equipo guarda sus propios widgets y su alcance: **Checkout team** sigue las pruebas de humo del checkout, sprint a sprint. Cualquier panel puede ir a una pantalla de pared en modo TV o enviarse como informe programado.',
        },
        reports: {
          title: 'Informes que se envían solos',
          body: 'Una programación envía un informe de calidad a sus canales cada día, semana o mes, en inglés o francés, y guarda cada uno aquí como instantánea. **Weekly engineering report** es una de ellas; en esta demo no se envía nada.',
        },
        issue: {
          title: 'Los fallos se convierten en tickets',
          body: 'Este fallo de inicio de sesión tiene su incidencia en DEMO-42, creada desde Piwi con el plan de corrección del grupo de fallos como descripción y ahora en «In Progress». Su clave y su estado acompañan al fallo: en esta página, en sus ejecuciones y en la bandeja de entrada. Un grupo sin ticket ofrece **Create issue** y **Link an issue**.',
        },
        personas: {
          title: 'Míralo como lo ve tu equipo',
          body: '**Acting as** recarga la demo como una de las siete personas de ejemplo, desde la administración hasta una parte interesada que solo puede leer E2E Checkout. Cada una ve lo que su rol permite.',
        },
      },
    },
    platform: {
      label: 'DevOps / plataforma',
      hint: 'Velocidad de la CI y estado de las máquinas',
      stops: {
        timeline: {
          title: 'En qué se fue el tiempo del run',
          body: 'Las pruebas de cada worker en una misma línea de tiempo, con la CPU, la memoria y las páginas abiertas de la máquina que las ejecutó. Este run se repartió en dos shards de CI: la máquina de cada shard tiene sus propias pistas, encima de sus dos workers.',
        },
        leaks: {
          title: 'Fugas entre pruebas',
          body: '**Findings** lista lo que las pruebas dejaron abierto más allá de su alcance, con la línea que lo abrió. Aquí la fixture loggedInContext deja un contexto de navegador abierto en las 10 pruebas, hasta que el worker se detiene.',
        },
        incident: {
          title: 'Cuando lo que cae es staging, no las pruebas',
          body: 'Diez de once pruebas fallaron al conectarse a staging, así que Piwi marcó el run como incidente de entorno. Las puntuaciones de inestabilidad, las líneas base, la verificación de correcciones y el control de la CI lo dejan fuera, y las gráficas de tendencia reciben una sola marca.',
        },
        alerts: {
          title: 'Alertas donde trabajas',
          body: 'Un canal es adonde van las alertas: un correo, un webhook de Slack o Microsoft Teams, o un webhook propio. Una suscripción elige luego los proyectos y los eventos, como un run fallido, un grupo de fallos nuevo o un incidente de entorno.',
        },
        setup: {
          title: 'Qué está activado',
          body: "**What's switched on** lee los datos de esta instancia, no su configuración, para mostrar qué funciones están en uso y qué necesita cada una de las demás, como un token del repositorio o un proveedor de IA. Los pasos de arriba conectan una suite.",
        },
        simulate: {
          title: 'Mira cómo llega un run en directo',
          body: '**Simulate a test run** envía un run nuevo a la demo, como lo hace el reporter desde la CI. **Leaky run** reproduce la fuga que acabas de ver: una fixture de inicio de sesión deja un contexto de navegador abierto en cada prueba.',
        },
      },
    },
  },
} satisfies TourCopy;
