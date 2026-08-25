export interface PublishValues { current?: boolean; harness?: string; password?: string; expires?: string; preset?: string; yes?: boolean; }
export async function runPublish(_values: PublishValues, _positionals: string[]): Promise<void> {
  throw new Error('not implemented');
}
