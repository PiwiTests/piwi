// The behavior of the sample app's pages. Each page names its behavior in `<body data-page="…">`; shop.js adds the
// shop's. Every backend serves this file unchanged.
const sample = {
  /** Page behaviors, by the name a page gives in `data-page`. */
  pages: {},

  /** A price in euros, as the pages show it. */
  price: (value) => '€' + Number(value).toFixed(2),

  /** Fetches a URL and reads its body: `body` is the parsed JSON, or the text when it is not JSON. */
  async request(url, init) {
    const response = await fetch(url, init);
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON: keep the text.
    }
    return { ok: response.ok, status: response.status, body };
  },

  /** A new element with its class and text. */
  element(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  },
};

/** Marks the current page in the navigation: a link to this page, and in the main navigation the section holding it. */
function markCurrentLinks() {
  const path = location.pathname;
  for (const link of document.querySelectorAll('nav a')) {
    const href = link.getAttribute('href');
    const inSection = link.closest('.main-nav') && href !== '/' && path.startsWith(href + '/');
    if (path === href || inSection) link.setAttribute('aria-current', 'page');
  }
}

sample.pages.home = () => {
  console.warn('demo: home page loaded');
  const list = document.getElementById('items');
  const error = document.getElementById('items-error');
  document.querySelector('[data-testid="load-items"]').addEventListener('click', async () => {
    error.textContent = '';
    const { ok, status, body: items } = await sample.request('/api/items');
    if (!ok) {
      error.textContent = `Could not load the items (${status}).`;
      return;
    }
    list.replaceChildren(
      ...items.map((item) => {
        const row = sample.element('li');
        row.append(
          sample.element('span', '', item.name),
          sample.element('span', item.stock < 5 ? 'badge low' : 'badge', `${item.stock} in stock`),
        );
        return row;
      }),
    );
  });
};

sample.pages.form = () => {
  const form = document.getElementById('contact');
  const result = document.getElementById('result');
  const error = document.getElementById('form-error');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    result.textContent = '';
    error.textContent = '';
    const email = form.elements.email.value;
    if (!email) {
      console.error('demo: email is required');
      error.textContent = 'Enter your email.';
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/submit');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = () => {
      if (xhr.status < 300) result.textContent = 'Sent!';
      else error.textContent = `The message was not sent (${xhr.status}).`;
    };
    xhr.send(JSON.stringify({ email, message: form.elements.message.value, priority: form.elements.priority.value }));
  });
};

sample.pages.popup = () => {
  document.querySelector('[data-testid="open-child"]').addEventListener('click', () => {
    window.open('/child', '_blank');
  });
};

sample.pages.child = () => {
  console.warn('demo: child window opened');
  document.querySelector('[data-testid="child-action"]').addEventListener('click', async () => {
    await sample.request('/api/child');
    document.getElementById('child-result').textContent = 'child done';
  });
};

sample.pages.slow = async () => {
  const timings = document.getElementById('timings');
  const timed = async (url) => {
    const start = performance.now();
    const { status } = await sample.request(url);
    const row = sample.element('li');
    row.append(
      sample.element('code', '', url),
      sample.element('span', 'badge', `${status} · ${Math.round(performance.now() - start)} ms`),
    );
    return row;
  };
  const rows = await Promise.all(['/api/slow', '/api/users/1', '/api/users/2'].map(timed));
  timings.replaceChildren(...rows);
  document.getElementById('status').textContent = 'done';
};

sample.pages.backend = () => {
  const result = document.getElementById('backend-result');
  document.querySelector('[data-testid="load-report"]').addEventListener('click', async () => {
    const { ok } = await sample.request('/api/report');
    result.textContent = ok ? 'report loaded' : 'report failed';
  });
  document.querySelector('[data-testid="trigger-failure"]').addEventListener('click', async () => {
    const { ok, status } = await sample.request('/api/failing');
    result.textContent = ok ? 'unexpectedly ok' : `backend failed as expected (${status})`;
  });
};

document.addEventListener('DOMContentLoaded', () => {
  markCurrentLinks();
  sample.pages[document.body.dataset.page]?.();
});
