// Shared host-runtime cache policy. Acquisition and transfer remain runtime-specific.
export {canonicalize, validate, decide, selectSnapshots, save, splitReplay, replayYearIncomplete, checkCacheAuthorized, parseCacheSettings} from './claude-code/save-capture.mjs';
export {equivalentRecords, meaningfulRecords} from './cache-semantics.mjs';
export {parseSettings, readSettingsFile} from './settings.mjs';
export {checkObservation, evaluateIdentity, identityPolicy} from './identity.mjs';
