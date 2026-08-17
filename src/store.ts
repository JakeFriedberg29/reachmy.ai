export type TestItem = {
  id: string;
  principalId: string;
  text: string;
  createdAt: string;
};

const items = new Map<string, TestItem[]>();

export function createTestItem(principalId: string, text: string): TestItem {
  const item: TestItem = {
    id: crypto.randomUUID(),
    principalId,
    text,
    createdAt: new Date().toISOString(),
  };
  const existing = items.get(principalId) ?? [];
  existing.push(item);
  items.set(principalId, existing);
  return item;
}

export function listTestItems(principalId: string): TestItem[] {
  return items.get(principalId) ?? [];
}
