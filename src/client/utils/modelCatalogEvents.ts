export const MODEL_CATALOG_CHANGED_EVENT = 'hermes-yaoyao:model-catalog-changed'

export function notifyModelCatalogChanged(profile: string): void {
  window.dispatchEvent(new CustomEvent(MODEL_CATALOG_CHANGED_EVENT, { detail: { profile } }))
}

export function modelCatalogChangedProfile(event: Event): string {
  return event instanceof CustomEvent && typeof event.detail?.profile === 'string' ? event.detail.profile : ''
}
