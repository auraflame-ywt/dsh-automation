// Artifact directory resolution for screenshots, recordings and browser profiles.
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { stamp } from './util.mjs'

/** Directory created inside the session working directory by default. */
export const ARTIFACT_DIRNAME = '.dsh-automation'

/**
 * Resolves and creates per-session artifact directories.
 */
export class ArtifactWriter {
  /**
   * @param {{ ctx: any, config: Record<string, unknown> }} options
   */
  constructor({ ctx, config }) {
    this.ctx = ctx
    this.config = config
    /** @type {Map<string, string>} */
    this.baseByAgent = new Map()
    this.fallbackBase = join(homedir(), '.dsh', 'automation-artifacts')
  }

  /**
   * Absolute artifact root for one execution.
   * @param {{ agent?: { id?: string } }} exec
   * @returns {Promise<string>}
   */
  async base(exec) {
    const configured = this.config.artifactDir
    if (typeof configured === 'string' && configured.trim().length > 0) {
      const base = resolve(configured.trim())
      await mkdir(base, { recursive: true })
      return base
    }
    const agentId = String(exec?.agent?.id ?? 'global')
    const cached = this.baseByAgent.get(agentId)
    if (cached !== undefined) return cached
    let sessionDir
    const workingDirectory = this.ctx.get?.('workingDirectory')
    if (workingDirectory !== undefined && exec?.agent !== undefined) {
      try {
        sessionDir = await workingDirectory.ensure(exec.agent, exec.signal)
      } catch {
        sessionDir = undefined
      }
    }
    const base = join(sessionDir ?? this.fallbackBase, ARTIFACT_DIRNAME)
    await mkdir(base, { recursive: true })
    this.baseByAgent.set(agentId, base)
    return base
  }

  /**
   * Ensure and return one artifact subdirectory, e.g. `screens`.
   * @param {{ agent?: { id?: string } }} exec
   * @param {string} subdir
   * @returns {Promise<string>}
   */
  async dir(exec, subdir = 'misc') {
    const base = await this.base(exec)
    const dir = join(base, subdir)
    await mkdir(dir, { recursive: true })
    return dir
  }

  /**
   * Allocate an unused artifact file path.
   * @param {{ agent?: { id?: string } }} exec
   * @param {string} subdir
   * @param {string} ext extension without the dot
   * @returns {Promise<string>}
   */
  async path(exec, subdir, ext) {
    const dir = await this.dir(exec, subdir)
    const suffix = Math.random().toString(36).slice(2, 8)
    const name = `${stamp()}-${suffix}.${ext.replace(/^\./u, '')}`
    return join(dir, name)
  }
}
