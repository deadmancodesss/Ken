/*
 * The one dropdown in this build. Tom Select is vendored rather than fetched, because
 * a demo on a venue network cannot wait for a CDN, and it is wrapped here so every
 * picker gets the same paper shape, the same keyboard behaviour and the same quiet
 * scroll. A page loads the vendor files only if it has a select.
 */
let loading = null;

function load() {
  if (window.TomSelect) return Promise.resolve(window.TomSelect);
  if (loading) return loading;
  loading = new Promise((ok, no) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/vendor/tom-select.css";
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = "/vendor/tom-select.min.js";
    js.onload = () => ok(window.TomSelect);
    js.onerror = () => no(new Error("the dropdown component did not load"));
    document.head.appendChild(js);
  });
  return loading;
}

export async function mountSelect(select, options = {}) {
  if (!select) return null;
  if (select.__paper) return select.__paper;
  const TomSelect = await load();
  if (!TomSelect || select.__paper) return select.__paper ?? null;
  const ts = new TomSelect(select, {
    maxItems: 1,
    allowEmptyOption: false,
    create: false,
    controlInput: null,
    dropdownParent: "body",
    wrapperClass: "ts-wrapper paper-select",
    dropdownClass: "ts-dropdown paper-menu",
    sortField: [],
    render: {
      option(data, escape) {
        const note = data.$option?.dataset?.note ?? "";
        return `<span>${escape(String(data.text))}</span>${note ? `<em>${escape(note)}</em>` : ""}`;
      },
      item(data, escape) {
        return `<div class="item">${escape(String(data.text))}</div>`;
      },
    },
    ...options,
  });
  select.__paper = ts;
  // Tom Select keeps the original select as the value carrier. It is hidden from the
  // eye but not from a form, a screen reader or the page's own change handler.
  return ts;
}

export function enhanceSelects(root = document) {
  return Promise.all([...root.querySelectorAll("select:not([data-plain])")].map((el) => mountSelect(el).catch(() => null)));
}

export function refreshSelect(select) {
  const ts = select?.__paper;
  if (!ts) return;
  const keep = select.value;
  ts.clearOptions();
  for (const opt of select.options) ts.addOption({ value: opt.value, text: opt.textContent, note: opt.dataset.note ?? "" });
  if (select.options.length) ts.setValue(keep && [...select.options].some((o) => o.value === keep) ? keep : select.options[0].value, true);
}
