import type { VerifiedDocumentAccess } from './access-control';
import type { VersionActorType } from './version-service';

export interface ValidatedVersionActor {
  actorType: VersionActorType;
  actorId?: string | undefined;
}

export function versionActorFromAccess(access: VerifiedDocumentAccess | void): ValidatedVersionActor {
  return {
    actorType: access?.actorType ?? 'system',
    actorId: access?.actorId,
  };
}
