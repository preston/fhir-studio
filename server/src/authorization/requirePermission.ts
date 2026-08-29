// Author: Preston Lee

import type { NextFunction, Request, Response } from 'express';
import type { PermissionKey } from './permissions.js';
import { hasPermission } from './permissions.js';

export function requirePermission(permission: PermissionKey) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.sessionAuth) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!hasPermission(req.effectivePermissions, permission)) {
      res.status(403).json({
        error: `Forbidden: permission '${permission}' required`,
      });
      return;
    }
    next();
  };
}
