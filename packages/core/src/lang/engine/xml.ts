/**
 * A reader for the XML manifests of a pack (`workspace.manifests`, format `xml`). It does not validate: it walks the tags
 * of the text and keeps, for each element path from the root (`project/dependencies/dependency/artifactId`), the trimmed
 * text of every element at that path, in document order, and, for each attribute of an element, its value under
 * `<element path>@<attribute>`. Comments, processing instructions and doctypes are skipped; CDATA is text; entities are
 * not decoded.
 */
export function readXml(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const stack: string[] = [];
  const tag =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!(?!\[CDATA)[^>]*>|<(\/?)([^\s/>]+)([^>]*?)(\/?)>/g;
  const attribute = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let pos = 0;
  const put = (key: string, value: string): void => {
    const list = out.get(key) ?? [];
    list.push(value);
    out.set(key, list);
  };
  const add = (raw: string): void => {
    const t = raw.trim();
    if (t === "" || stack.length === 0) return;
    put(stack.join("/"), t);
  };
  for (const m of text.matchAll(tag)) {
    add(text.slice(pos, m.index));
    pos = (m.index ?? 0) + m[0].length;
    if (m[1] !== undefined) add(m[1]);
    else if (m[3] !== undefined) {
      if (m[2] === "/") stack.pop();
      else {
        const path = [...stack, m[3]].join("/");
        for (const a of (m[4] ?? "").matchAll(attribute)) put(`${path}@${a[1]}`, a[2] ?? a[3] ?? "");
        if (m[5] !== "/") stack.push(m[3]);
      }
    }
  }
  return out;
}
