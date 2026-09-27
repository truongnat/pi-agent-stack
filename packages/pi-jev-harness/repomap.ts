import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isNativeAvailable, scanDirectory } from 'pi-native-bridge'

export interface ProjectSurface {
	path: string
	name: string
	type: string
}

/**
 * Fast filesystem scanner (< 5ms) that detects monorepo surfaces and framework types.
 */
const MONOREPO_PARENTS = new Set(['apps', 'packages', 'services', 'modules', 'src'])

function formatSurfaces(surfaces: ProjectSurface[]): string {
	const formatted = surfaces
		.slice(0, 8)
		.map((s) => `${s.path} [${s.type}]`)
		.join(', ')
	return surfaces.length > 8 ? `${formatted}, ... (+${surfaces.length - 8} more)` : formatted
}

function surfacesFromNativeScan(cwd: string): ProjectSurface[] {
	if (!isNativeAvailable()) return []
	const entries = scanDirectory(cwd, 2)
	const surfaces: ProjectSurface[] = []
	const seen = new Set<string>()
	for (const e of entries) {
		if (!e.is_dir) continue
		const rel = e.path.replaceAll('\\', '/')
		const parts = rel.split('/')
		if (parts.length !== 2 || !MONOREPO_PARENTS.has(parts[0]!)) continue
		if (seen.has(rel)) continue
		seen.add(rel)
		surfaces.push({
			path: rel,
			name: parts[1]!,
			type: identifyProjectType(join(cwd, rel))
		})
	}
	return surfaces
}

export function scanRepoMap(cwd: string): string | null {
	try {
		const nativeSurfaces = surfacesFromNativeScan(cwd)
		if (nativeSurfaces.length > 0) {
			return formatSurfaces(nativeSurfaces)
		}

		const surfaces: ProjectSurface[] = []
		const checkDirs = ['apps', 'packages', 'services', 'modules', 'src']

		// 1. Check monorepo child directories
		for (const parent of checkDirs) {
			const parentPath = join(cwd, parent)
			if (existsSync(parentPath) && statSync(parentPath).isDirectory()) {
				const entries = readdirSync(parentPath)
				for (const entry of entries) {
					if (entry.startsWith('.')) continue
					const subPath = join(parentPath, entry)
					try {
						if (statSync(subPath).isDirectory()) {
							const type = identifyProjectType(subPath)
							surfaces.push({
								path: `${parent}/${entry}`,
								name: entry,
								type
							})
						}
					} catch {
						// Skip inaccessible subdirs
					}
				}
			}
		}

		// 2. If no multi-surface subdirs, check root project
		if (surfaces.length === 0) {
			const rootType = identifyProjectType(cwd)
			if (rootType !== 'Unknown') {
				return `Single Project (${rootType})`
			}
			return null
		}

		return formatSurfaces(surfaces)
	} catch {
		return null
	}
}

/**
 * Detect framework / runtime type of a project directory from its manifest files.
 */
export function identifyProjectType(dir: string): string {
	try {
		// Flutter / Dart
		if (existsSync(join(dir, 'pubspec.yaml'))) {
			try {
				const content = readFileSync(join(dir, 'pubspec.yaml'), 'utf8')
				if (content.includes('flutter:')) return 'Flutter Mobile/App'
				return 'Dart'
			} catch {
				return 'Flutter/Dart'
			}
		}

		// Rust
		if (existsSync(join(dir, 'Cargo.toml'))) return 'Rust'

		// Go
		if (existsSync(join(dir, 'go.mod'))) return 'Go'

		// Python
		if (
			existsSync(join(dir, 'pyproject.toml')) ||
			existsSync(join(dir, 'requirements.txt')) ||
			existsSync(join(dir, 'setup.py'))
		) {
			return 'Python'
		}

		// Node / TypeScript / JavaScript
		const pkgPath = join(dir, 'package.json')
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
				const deps = { ...pkg.dependencies, ...pkg.devDependencies }

				if (
					deps['next'] ||
					existsSync(join(dir, 'next.config.js')) ||
					existsSync(join(dir, 'next.config.mjs')) ||
					existsSync(join(dir, 'next.config.ts'))
				) {
					return 'Next.js Web'
				}
				if (deps['@nestjs/core']) return 'NestJS API'
				if (deps['react-native'] || deps['expo']) return 'React Native Mobile'
				if (deps['react']) return 'React Web'
				if (deps['vue'] || deps['nuxt']) return 'Vue/Nuxt Web'
				if (deps['express'] || deps['fastify'] || deps['koa']) return 'Node.js Backend'
				if (deps['typescript'] || existsSync(join(dir, 'tsconfig.json'))) return 'TypeScript'
				return 'Node.js'
			} catch {
				return 'Node/TS'
			}
		}
	} catch {
		// Fallback
	}

	return 'General'
}
