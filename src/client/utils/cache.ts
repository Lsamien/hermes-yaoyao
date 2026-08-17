import { openDB, type IDBPDatabase } from 'idb'

const memory = new Map<string, unknown>()
let databasePromise: Promise<IDBPDatabase | null> | undefined

async function database(): Promise<IDBPDatabase | null> {
  if (typeof indexedDB === 'undefined') return null
  databasePromise ??= openDB('hermes-yaoyao-cache', 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains('records')) database.createObjectStore('records')
    },
  }).catch(() => null)
  return databasePromise
}

export class ScopedCache<T> {
  constructor(private readonly namespace: string, private readonly maximumBytes = 16 * 1024 * 1024) {}

  private key(scope: string, key: string): string { return `${this.namespace}:${scope}:${key}` }

  async get(scope: string, key: string): Promise<T | undefined> {
    const storageKey = this.key(scope, key)
    const db = await database()
    if (!db) return memory.get(storageKey) as T | undefined
    try { return await db.get('records', storageKey) as T | undefined } catch { return memory.get(storageKey) as T | undefined }
  }

  async set(scope: string, key: string, value: T): Promise<void> {
    const serialized = JSON.stringify(value)
    if (new Blob([serialized]).size > this.maximumBytes) return
    const storageKey = this.key(scope, key)
    memory.set(storageKey, value)
    const db = await database()
    if (db) await db.put('records', value, storageKey).catch(() => undefined)
  }

  async delete(scope: string, key: string): Promise<void> {
    const storageKey = this.key(scope, key)
    memory.delete(storageKey)
    const db = await database()
    if (db) await db.delete('records', storageKey).catch(() => undefined)
  }
}
