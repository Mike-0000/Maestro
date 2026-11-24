/**
 * Keeps a child window's blank document styled like the main one: the same stylesheets (and the
 * ones added later, such as lazily loaded chunks and dev-server updates), and the same attributes
 * on `<html>` and `<body>`, where the theme lives. Returns a function that stops mirroring.
 */
export function mirrorDocument(source: Document, target: Document): () => void {
  const base = target.createElement('base');
  base.href = source.baseURI;
  target.head.appendChild(base);

  const meta = target.createElement('meta');
  meta.setAttribute('charset', 'utf-8');
  target.head.appendChild(meta);

  let clones: Node[] = [];
  const syncStyles = () => {
    for (const clone of clones) clone.parentNode?.removeChild(clone);
    clones = [];
    for (const node of source.head.querySelectorAll('style, link[rel="stylesheet"]')) {
      const clone = target.importNode(node, true);
      target.head.appendChild(clone);
      clones.push(clone);
    }
  };

  const syncAttributes = (from: Element, to: Element) => {
    for (const { name } of [...to.attributes]) {
      if (!from.hasAttribute(name)) to.removeAttribute(name);
    }
    for (const { name, value } of [...from.attributes]) {
      if (to.getAttribute(name) !== value) to.setAttribute(name, value);
    }
  };

  syncStyles();
  syncAttributes(source.documentElement, target.documentElement);
  syncAttributes(source.body, target.body);

  // Style changes come in bursts (a chunk adds several sheets); copy once per burst.
  let pending = false;
  const styleObserver = new MutationObserver(() => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      syncStyles();
    });
  });
  styleObserver.observe(source.head, { childList: true, subtree: true, characterData: true });

  const attributeObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.target === source.documentElement) {
        syncAttributes(source.documentElement, target.documentElement);
      } else if (record.target === source.body) {
        syncAttributes(source.body, target.body);
      }
    }
  });
  attributeObserver.observe(source.documentElement, { attributes: true });
  attributeObserver.observe(source.body, { attributes: true });

  return () => {
    styleObserver.disconnect();
    attributeObserver.disconnect();
  };
}
