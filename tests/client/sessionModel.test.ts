import { describe, expect, it } from 'vitest'
import { modelForSession } from '@/utils/sessionModel'

const models = [
  { id: 'gpt-5.6-terra', name: 'GPT 5.6 Terra', provider: 'custom' },
  { id: 'glm-5.3', name: 'GLM 5.3', provider: 'custom', isDefault: true },
]

describe('session model selection', () => {
  it('restores the saved model case-insensitively instead of the profile default', () => {
    expect(modelForSession(models, 'GPT-5.6-terra', 'CUSTOM')).toEqual(models[0])
  })

  it('keeps an unavailable stored model visible until the user chooses another', () => {
    expect(modelForSession(models, 'archived-model', 'legacy')).toEqual({ id: 'archived-model', name: 'archived-model', provider: 'legacy' })
  })
})
