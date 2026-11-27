import { t } from '@renderer/utils/translate'
import type { ISettingConfig } from 'src/types/globals'
import {
  SETTINGS_CATALOG,
  SETTINGS_PAGE_BY_ID,
  isSettingAvailable,
  type SettingId,
  type SettingMeta
} from './settingsCatalog'

export type SettingsSearchContext = {
  setting: ISettingConfig
  isDevOrPrerelease: boolean
}

const normalizeText = (value: string): string => value.trim().toLocaleLowerCase()

const scoreField = (field: string, token: string): number => {
  if (!field) return 0
  if (field === token) return 120
  if (field.startsWith(token)) return 100
  if (field.includes(token)) return 80
  return 0
}

const scoreAlias = (alias: string, token: string): number => {
  if (!alias) return 0
  if (alias === token) return 70
  if (alias.startsWith(token)) return 65
  if (alias.includes(token)) return 55
  return 0
}

const collectSearchFields = (meta: SettingMeta) => {
  const page = SETTINGS_PAGE_BY_ID[meta.page]
  const label = normalizeText(t(meta.labelKey))
  const pageLabel = normalizeText(t(page.labelKey))
  const aliases = meta.aliases.map(normalizeText).filter(Boolean)
  return { label, pageLabel, aliases }
}

const matchesToken = (field: ReturnType<typeof collectSearchFields>, token: string): number => {
  const labelScore = scoreField(field.label, token)
  const aliasScore = Math.max(0, ...field.aliases.map((alias) => scoreAlias(alias, token)))
  const primaryScore = Math.max(labelScore, aliasScore)
  if (primaryScore === 0) return 0
  // 分类名只作为命中后的加权，避免搜“指纹”时把整个“分析与指纹”分类都翻出来。
  return primaryScore + (field.pageLabel.includes(token) ? 10 : 0)
}

export const searchSettings = (rawQuery: string, context: SettingsSearchContext): SettingId[] => {
  const query = normalizeText(rawQuery)
  if (!query) return []

  const tokens = query.split(/\s+/).filter(Boolean)
  const scored: Array<{ id: SettingId; score: number; order: number }> = []

  for (const meta of SETTINGS_CATALOG) {
    if (
      !isSettingAvailable(meta, context.setting, {
        isDevOrPrerelease: context.isDevOrPrerelease,
        platform: context.setting.platform
      })
    ) {
      continue
    }

    const fields = collectSearchFields(meta)
    let total = 0
    let allMatched = true

    for (const token of tokens) {
      const tokenScore = matchesToken(fields, token)
      if (tokenScore <= 0) {
        allMatched = false
        break
      }
      total += tokenScore
    }

    if (!allMatched) continue

    // 完整查询命中标题时给出额外权重，避免被多个别名分散。
    if (fields.label.includes(query)) total += 30

    scored.push({ id: meta.id, score: total, order: meta.order })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.order - b.order
  })

  return scored.map((item) => item.id)
}
