// Author: Preston Lee

import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideToastr } from 'ngx-toastr';
import { provideEchartsCore } from 'ngx-echarts';
import { AppComponent } from './app/app.component.js';
import { routes } from './app/app.routes.js';
import { authInterceptor } from './app/core/interceptors/auth.interceptor.js';

bootstrapApplication(AppComponent, {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptor])),
    provideAnimations(),
    provideToastr({ positionClass: 'toast-bottom-right' }),
    provideEchartsCore({
      echarts: () => import('./app/echarts/echarts-bundle.js').then((m) => m.echarts),
    }),
  ],
}).catch((err) => console.error(err));
