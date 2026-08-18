export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function notFound(message = "Not found"): DomainError {
  return new DomainError("not_found", message, 404);
}

export function forbidden(message = "Forbidden"): DomainError {
  return new DomainError("forbidden", message, 403);
}

export function conflict(message: string): DomainError {
  return new DomainError("conflict", message, 409);
}

export function invalidState(message: string): DomainError {
  return new DomainError("invalid_state", message, 409);
}

export function unauthorized(message = "Unauthorized"): DomainError {
  return new DomainError("unauthorized", message, 401);
}

export function onboardingRequired(message = "Choose your Agent Name before using the network"): DomainError {
  return new DomainError("onboarding_required", message, 409);
}
