import type { FactSheet } from "../types.js";

// Fake credentials are assembled from pieces so no scanner (ours or a host's) sees a whole key in this file.
export const FAKE = {
  aws: `${"AKIA"}${"IOSFODNN7EXAMPLE"}`,
  github: `${"ghp"}_${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`,
  slack: `${"xoxb"}-${"123456789012"}-${"abcdefABCDEF123456"}`,
  stripe: `${"sk"}_${"live"}_${"4eC39HqLyjWDarjtT1zdp7dc"}`,
  jwt: `${"eyJhbGciOiJIUzI1NiJ9"}.${"eyJzdWIiOiIxMjM0NTY3ODkwIn0"}.${"dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"}`,
  pem: `${"-----BEGIN RSA"} ${"PRIVATE KEY-----"}\nMIIEowIBAAKCAQEA7\n${"-----END RSA"} ${"PRIVATE KEY-----"}`,
  conn: `${"postgres"}://${"admin"}:${"hunter2pass"}@db.internal:5432/app`,
  blob: "q8Zr3Vt9Lw2Xb7Nk4Hs6Jd1Fg5Ya0Pc8Ue3Mo",
};

export function sheet(over: Partial<FactSheet> = {}): FactSheet {
  return {
    contentKey: "k1",
    id: "src/session.ts#clearCachedSession",
    path: "src/session.ts",
    kind: "function",
    signature: "(userId: string) => Promise<void>",
    doc: "Clears the cached session for a user.",
    callees: ["cache.remove", "logAudit"],
    returnType: "Promise<void>",
    body: "const user_key = makeKey(userId);\nawait cache.remove(user_key);\nlogAudit('session cleared');\n",
    ...over,
  };
}
