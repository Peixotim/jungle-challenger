import { CanActivate } from '@nestjs/common';

export abstract class AuthGuard implements CanActivate {
  abstract canActivate(): boolean | Promise<boolean>;
}

export class NoopAuthGuard extends AuthGuard {
  canActivate(): boolean {
    return true;
  }
}
