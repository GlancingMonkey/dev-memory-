// Local machine paths stay in VS Code's globalState; they are never API fields.
export interface ProjectRoot { name: string; uri: string; preferred?: boolean }
interface LocalState {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

export function relativeSourceParts(path: string): string[] | null {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (!normalized || normalized.startsWith('/') || /^[a-z]:/i.test(normalized)
      || parts.includes('..') || normalized.endsWith('/')) {
    return null;
  }
  return parts.filter((part) => part && part !== '.');
}

function validRoot(value: unknown): value is ProjectRoot {
  if (!value || typeof value !== 'object') { return false; }
  const root = value as Partial<ProjectRoot>;
  if (typeof root.name !== 'string' || !root.name.trim() || typeof root.uri !== 'string') { return false; }
  if (root.preferred !== undefined && typeof root.preferred !== 'boolean') { return false; }
  try {
    const uri = new URL(root.uri);
    return (uri.protocol === 'file:' || uri.protocol === 'vscode-remote:') && !!uri.pathname;
  } catch { return false; }
}

export class ProjectLocations {
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: LocalState,
    private readonly openRoots: () => readonly ProjectRoot[],
    private readonly key = 'codeMemory.projectLocations.v1.local',
  ) {}

  private read(): ProjectRoot[] {
    const stored = this.state.get<unknown>(this.key, []);
    return Array.isArray(stored) ? stored.filter(validRoot) : [];
  }

  rememberOpen(): Promise<void> {
    return this.remember(this.openRoots());
  }

  connect(name: string, uri: string): Promise<void> {
    return this.remember([{ name, uri, preferred: true }]);
  }

  private remember(roots: readonly ProjectRoot[]): Promise<void> {
    const captured = roots.filter(validRoot);
    const operation = this.writes.then(async () => {
      const stored = this.read().map((root) => ({ ...root }));
      for (const root of captured) {
        if (root.preferred) {
          for (const item of stored) {
            if (item.name === root.name) { item.preferred = false; }
          }
        }
        const existing = stored.find((item) => item.name === root.name && item.uri === root.uri);
        if (existing) {
          if (root.preferred) { existing.preferred = true; }
        } else {
          stored.push({ ...root });
        }
      }
      await this.state.update(this.key, stored);
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }

  rootFor(name: string | null): string | null {
    if (!name) { return null; }
    const remembered = this.read().filter((root) => root.name === name);
    const preferred = remembered.filter((root) => root.preferred);
    if (preferred.length === 1) { return preferred[0].uri; }
    const current = this.openRoots().filter((root) => root.name === name);
    const currentUris = [...new Set(current.map((root) => root.uri))];
    if (currentUris.length === 1) { return currentUris[0]; }
    if (currentUris.length > 1) { return null; }
    const uris = [...new Set(remembered.map((root) => root.uri))];
    return uris.length === 1 ? uris[0] : null;
  }
}
