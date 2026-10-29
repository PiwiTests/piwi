// The stage: draws one frame of the cut from what the renderer computed for it (`lib/cut-plan.mjs`), the windows cut
// from the master's frame on Piwi's background, the pointer, the click rings, the key strip, the chapter's label and
// the cards; and, in the renderer's other passes, a subtitle's plate alone or the contact sheet.
(() => {
  /** The stage's frame bar, a window's corner and its label, in master pixels (the plan's `TITLE_BAR`). */
  let sizes = { bar: 64, radius: 24, label: 26 };
  const dpr = window.devicePixelRatio || 1;
  const master = new Image();
  let shown = null;
  const windows = new Map();
  const $ = (id) => document.getElementById(id);
  const snap = (v) => Math.round(v * dpr) / dpr;

  /** A window's frame on the stage: its bar with its name, and the canvas its content is drawn on. */
  function windowFor(id, name) {
    if (!windows.has(id)) {
      const element = document.createElement('div');
      element.className = 'window';
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.textContent = name;
      const canvas = document.createElement('canvas');
      element.append(bar, canvas);
      $('windows').append(element);
      windows.set(id, { element, bar, canvas, context: canvas.getContext('2d') });
    }
    return windows.get(id);
  }

  async function load(frame) {
    if (frame === null || frame === shown) return;
    master.src = `master/${frame}.jpg`;
    await master.decode();
    shown = frame;
  }

  function drawWindows(state) {
    const visible = new Set();
    state.windows.forEach((w, z) => {
      visible.add(w.id);
      const { element, bar, canvas, context } = windowFor(w.id, w.name);
      const frame = {
        x: snap(w.frame.x),
        y: snap(w.frame.y),
        width: snap(w.frame.width),
        height: snap(w.frame.height),
      };
      Object.assign(element.style, {
        display: 'block',
        left: `${frame.x}px`,
        top: `${frame.y}px`,
        width: `${frame.width}px`,
        height: `${frame.height}px`,
        opacity: String(w.opacity),
        zIndex: String(z + 1),
        borderRadius: `${sizes.radius * state.scale}px`,
      });
      const barHeight = snap(w.content.y - w.frame.y);
      Object.assign(bar.style, { height: `${barHeight}px`, fontSize: `${sizes.label * state.scale}px` });
      const width = Math.round(w.content.width * dpr);
      const height = Math.round(w.content.height * dpr);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      Object.assign(canvas.style, {
        top: `${barHeight}px`,
        width: `${width / dpr}px`,
        height: `${height / dpr}px`,
      });
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      if (shown !== null)
        context.drawImage(master, w.crop.x, w.crop.y, w.crop.width, w.crop.height, 0, 0, width, height);
    });
    for (const [id, { element }] of windows) if (!visible.has(id)) element.style.display = 'none';
  }

  function drawPointer(state) {
    const pointer = $('pointer');
    if (!state.pointer) {
      pointer.style.display = 'none';
      return;
    }
    const { x, y, opacity, pressed } = state.pointer;
    Object.assign(pointer.style, {
      display: 'block',
      opacity: String(opacity),
      transform: `translate(${x - 3}px, ${y - 2}px) scale(${pressed ? 0.88 : 1})`,
    });
  }

  function drawRings(state) {
    const rings = $('rings');
    while (rings.children.length < state.rings.length) {
      const ring = document.createElement('div');
      ring.className = 'ring';
      rings.append(ring);
    }
    [...rings.children].forEach((ring, i) => {
      const r = state.rings[i];
      if (!r) {
        ring.style.display = 'none';
        return;
      }
      const size = 18 + r.progress * 70;
      Object.assign(ring.style, {
        display: 'block',
        left: `${r.x - size / 2}px`,
        top: `${r.y - size / 2}px`,
        width: `${size}px`,
        height: `${size}px`,
        opacity: String(r.opacity),
      });
    });
  }

  function drawKeys(state) {
    const keys = $('keys');
    if (!state.keys) {
      keys.style.display = 'none';
      return;
    }
    const text = JSON.stringify([state.keys.caps, state.keys.label]);
    if (keys.dataset.text !== text) {
      keys.dataset.text = text;
      keys.replaceChildren();
      state.keys.caps.forEach((cap, i) => {
        if (i) keys.append(Object.assign(document.createElement('span'), { className: 'plus', textContent: '+' }));
        const kbd = Object.assign(document.createElement('kbd'), { textContent: cap });
        if (cap === 'Agent') kbd.className = 'agent';
        keys.append(kbd);
      });
      if (state.keys.label) {
        keys.append(
          Object.assign(document.createElement('span'), { className: 'label', textContent: state.keys.label }),
        );
      }
    }
    Object.assign(keys.style, { display: 'flex', opacity: String(state.keys.opacity) });
  }

  function drawLabels(state) {
    const chapter = $('chapter');
    if (state.chapter) {
      chapter.querySelector('.number').textContent = String(state.chapter.number);
      chapter.querySelector('.title').textContent = state.chapter.title;
      Object.assign(chapter.style, { display: 'flex', opacity: String(state.chapter.opacity) });
    } else chapter.style.display = 'none';
    const fast = $('fast');
    if (state.fast) {
      fast.textContent = `▶▶ ×${state.fast.rate}`;
      Object.assign(fast.style, { display: 'block', opacity: String(state.fast.opacity) });
    } else fast.style.display = 'none';
    for (const id of ['title', 'end']) {
      const card = $(`card-${id}`);
      const opacity = state.card?.id === id ? state.card.opacity : 0;
      Object.assign(card.style, { display: opacity > 0 ? 'flex' : 'none', opacity: String(opacity) });
    }
  }

  window.stage = {
    /** The title card's line, and the sizes of the stage's frames. */
    setup({ title, frame }) {
      $('card-title').querySelector('.line').textContent = title;
      sizes = { ...sizes, ...frame };
      return document.fonts.ready;
    },

    /** Draws `state`, once its master frame is decoded. */
    async draw(state) {
      await load(state.frame);
      drawWindows(state);
      drawPointer(state);
      drawRings(state);
      drawKeys(state);
      drawLabels(state);
    },

    /** Shows a subtitle's plate alone, its `rows` one under the other, on a transparent page; none without rows. */
    plate(rows) {
      document.documentElement.className = 'plate';
      const plate = $('plate');
      plate.replaceChildren(...rows.flatMap((row, i) => (i ? [document.createElement('br'), row] : [row])));
      plate.style.visibility = rows.length ? 'visible' : 'hidden';
    },

    /** Shows the contact sheet: each item's image (`src`) above its caption (`number`, `title`, `time`). */
    async sheet(items) {
      document.documentElement.className = 'sheet';
      const sheet = $('sheet');
      sheet.replaceChildren(
        ...items.map((item) => {
          const figure = document.createElement('figure');
          const img = Object.assign(document.createElement('img'), { src: item.src });
          const caption = document.createElement('figcaption');
          caption.append(Object.assign(document.createElement('b'), { textContent: `${item.number} · ${item.title}` }));
          caption.append(` · ${item.time}`);
          figure.append(img, caption);
          return figure;
        }),
      );
      await Promise.all([...sheet.querySelectorAll('img')].map((img) => img.decode()));
    },
  };
})();
