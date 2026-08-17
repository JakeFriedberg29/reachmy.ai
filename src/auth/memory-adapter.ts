import { createHash } from "node:crypto";

type MemoryRecord = Record<string, unknown> & { exp?: number };

const stores = new Map<string, Map<string, MemoryRecord>>();

function grantIdIndex() {
  if (!stores.has("GrantIdIndex")) {
    stores.set("GrantIdIndex", new Map());
  }
  return stores.get("GrantIdIndex")!;
}

function uidIndex() {
  if (!stores.has("UidIndex")) {
    stores.set("UidIndex", new Map());
  }
  return stores.get("UidIndex")!;
}

function userCodeIndex() {
  if (!stores.has("UserCodeIndex")) {
    stores.set("UserCodeIndex", new Map());
  }
  return stores.get("UserCodeIndex")!;
}

export class MemoryAdapter {
  model: string;
  store: Map<string, MemoryRecord>;

  constructor(model: string) {
    this.model = model;
    if (!stores.has(model)) {
      stores.set(model, new Map());
    }
    this.store = stores.get(model)!;
  }

  key(id: string) {
    return id;
  }

  async upsert(id: string, payload: MemoryRecord, expiresIn?: number) {
    const rec = { ...payload };
    if (expiresIn) {
      rec.exp = Math.floor(Date.now() / 1000) + expiresIn;
    }
    this.store.set(this.key(id), rec);
    if (typeof rec.grantId === "string") {
      const grants = grantIdIndex();
      const list = (grants.get(rec.grantId)?.ids as string[] | undefined) ?? [];
      if (!list.includes(id)) list.push(id);
      grants.set(rec.grantId, { ids: list });
    }
    if (typeof rec.uid === "string") {
      uidIndex().set(rec.uid, { id });
    }
    if (typeof rec.userCode === "string") {
      userCodeIndex().set(rec.userCode, { id });
    }
  }

  async find(id: string) {
    const rec = this.store.get(this.key(id));
    if (!rec) return undefined;
    if (rec.exp && rec.exp < Math.floor(Date.now() / 1000)) {
      this.store.delete(this.key(id));
      return undefined;
    }
    return rec;
  }

  async findByUserCode(userCode: string) {
    const ref = userCodeIndex().get(userCode);
    return ref?.id ? this.find(String(ref.id)) : undefined;
  }

  async findByUid(uid: string) {
    const ref = uidIndex().get(uid);
    return ref?.id ? this.find(String(ref.id)) : undefined;
  }

  async consume(id: string) {
    const rec = await this.find(id);
    if (!rec) return;
    rec.consumed = Math.floor(Date.now() / 1000);
    this.store.set(this.key(id), rec);
  }

  async destroy(id: string) {
    this.store.delete(this.key(id));
  }

  async revokeByGrantId(grantId: string) {
    const grants = grantIdIndex();
    const list = (grants.get(grantId)?.ids as string[] | undefined) ?? [];
    for (const id of list) {
      this.store.delete(this.key(id));
    }
    grants.delete(grantId);
  }
}

export function hashRedirectUri(uri: string): string {
  return createHash("sha256").update(uri).digest("hex");
}
