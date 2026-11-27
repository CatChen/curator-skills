// Shared host-runtime cache policy. Acquisition and transfer remain runtime-specific.
export {canonicalize, validate, save, splitReplay, replayYearIncomplete, checkCacheAuthorized, parseCacheSettings} from './claude-code/save-capture.mjs';
export {parseSettings, readSettingsFile} from './settings.mjs';
export {checkObservation, evaluateIdentity, identityPolicy} from './identity.mjs';
