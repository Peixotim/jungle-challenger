import type { NextFunction, Request, Response } from 'express';

// Swagger UI needs its own scripts, inline styles and data: images; everything else stays locked down.
const DOCS_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

export function securityHeadersMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader(
    'Content-Security-Policy',
    /^\/docs(\/|-json|-yaml|$)/.test(request.path)
      ? DOCS_CSP
      : "default-src 'none'; frame-ancestors 'none'",
  );
  next();
}
