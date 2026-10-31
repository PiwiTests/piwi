// Click-to-zoom for the images of the content: a figure's image, or one of the
// home page's screenshots, shown smaller than its native size opens over the
// page at up to the window's size. A click anywhere or Escape closes it.
const ZOOMABLE = '.vp-doc figure img, .vp-doc .screenshots img'

const isShrunk = (img: HTMLImageElement) => img.naturalWidth > img.clientWidth + 8

const zoomableImage = (target: EventTarget | null) =>
  target instanceof HTMLImageElement && target.matches(ZOOMABLE) && !target.closest('a') ? target : null

function open(img: HTMLImageElement) {
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const overlay = document.createElement('div')
  overlay.className = 'image-zoom'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', img.alt || 'Enlarged image')
  overlay.tabIndex = -1
  const large = document.createElement('img')
  large.src = img.currentSrc || img.src
  large.alt = img.alt
  overlay.append(large)

  const close = () => {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
    returnFocus?.focus()
  }
  // The dialog holds the focus until it closes: Escape closes it, Tab stays in it.
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close()
    else if (event.key === 'Tab') event.preventDefault()
  }
  overlay.addEventListener('click', close)
  document.addEventListener('keydown', onKey)
  document.body.append(overlay)
  overlay.focus()
}

export function installImageZoom() {
  document.addEventListener('mouseover', (event) => {
    const img = zoomableImage(event.target)
    if (img) img.classList.toggle('zoomable', isShrunk(img))
  })
  document.addEventListener('click', (event) => {
    const img = zoomableImage(event.target)
    if (img && isShrunk(img)) open(img)
  })
}
