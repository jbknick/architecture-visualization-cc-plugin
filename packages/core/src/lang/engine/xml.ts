/**
 * A reader for the XML manifests of a pack (`workspace.manifests`, format `xml`). It does not validate: it walks the tags
 * of the text and keeps, for each element path from the root (`project/dependencies/dependency/artifactId`), the trimmed
 * text of every element at that path, in document order. Comments, processing instructions, doctypes and attributes are
 * skipped; CDATA is text; entities are not decoded.
 */
export function readXml(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const stack: string[] = [];
  const tag =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!(?!\[CDATA)[^>]*>|<(\/?)([^\s/>]+)[^>]*?(\/?)>/g;
  let pos = 0;
  const add = (raw: string): void => {
    const t = raw.trim();
    if (t === "" || stack.length === 0) return;
    const key = stack.join("/");
    const list = out.get(key) ?? [];
    list.push(t);
    out.set(key, list);
  };
  for (const m of text.matchAll(tag)) {
    add(text.slice(pos, m.index));
    pos = (m.index ?? 0) + m[0].length;
    if (m[1] !== undefined) add(m[1]);
    else if (m[3] !== undefined) {
      if (m[2] === "/") stack.pop();
      else if (m[4] !== "/") stack.push(m[3]);
    }
  }
  return out;
}
