import type { RepositoryFile } from '@fhir-studio/core';

// A portable SMART public client. All network access is explicit and credentialless.
const smart = `export async function launch() {
 const config = await fetch('/_studio/config.json', {cache:'no-store'}).then(r=>r.json());
 const params = new URLSearchParams(location.search);
 const key = 'studio-smart-' + config.clientId;
 if (!params.has('code')) {
  const iss = params.get('iss');
  if (!iss) return {message:'Use Test in sandbox in FHIR Studio to launch this app.'};
  const issuer = new URL(iss);
  if (issuer.origin !== config.studioOrigin || !/^\\/api\\/sandboxes\\/[^/]+\\/fhir\\/[^/]+$/.test(issuer.pathname)) throw Error('Unapproved FHIR issuer');
  const discovery = await fetch(iss+'/.well-known/smart-configuration',{credentials:'omit'}).then(r=>r.json());
  if ([discovery.authorization_endpoint,discovery.token_endpoint].some(url=>new URL(url).origin!==config.studioOrigin)) throw Error('Unapproved SMART endpoint');
  const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,'0')).join('');
  const verifier=random(), state=random();
  const challenge=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
  sessionStorage.setItem(key,JSON.stringify({iss,verifier,state,token:discovery.token_endpoint}));
  const url=new URL(discovery.authorization_endpoint);
  Object.entries({response_type:'code',client_id:config.clientId,redirect_uri:location.origin+'/'+config.callbackPath,scope:config.scope,aud:iss,state,code_challenge:challenge,code_challenge_method:'S256',...(params.has('launch')?{launch:params.get('launch')}:{})}).forEach(([k,v])=>url.searchParams.set(k,v));
  location.replace(url); return {message:'Authorizing…'};
 }
 const saved=JSON.parse(sessionStorage.getItem(key)||'null');
 if (!saved || saved.state!==params.get('state')) throw Error('SMART state mismatch. Launch again from Studio.');
 sessionStorage.removeItem(key);
 const response=await fetch(saved.token,{method:'POST',credentials:'omit',body:new URLSearchParams({grant_type:'authorization_code',code:params.get('code'),client_id:config.clientId,redirect_uri:location.origin+'/'+config.callbackPath,code_verifier:saved.verifier})});
 if(!response.ok) throw Error('SMART token exchange failed');
 const token=await response.json(); history.replaceState(null,'',location.pathname);
 const resource=token.patient?'Patient/'+encodeURIComponent(token.patient):'Patient?_count=5';
 const result=await fetch(saved.iss+'/'+resource,{credentials:'omit',headers:{Authorization:'Bearer '+token.access_token}});
 if(!result.ok) throw Error('FHIR request denied ('+result.status+')');
 return result.json();
}`;
export const curatedTemplates = [
  {
    id: 'javascript',
    name: 'JavaScript SMART patient viewer',
    kind: 'curated',
  },
  {
    id: 'react',
    name: 'React / TypeScript SMART patient viewer',
    kind: 'curated',
  },
  { id: 'angular', name: 'Angular SMART patient viewer', kind: 'curated' },
];
export function templateFiles(kind: string): RepositoryFile[] {
  const readme = {
    path: 'README.md',
    content:
      '# SMART application\n\nBuilds are run by GitHub Actions. Hosted files and source maps are public. Use FHIR Studio to select a sandbox and patient, then launch the preview. No server or secrets are required.\n',
  };
  if (kind === 'javascript')
    return [
      readme,
      {
        path: 'package.json',
        content: JSON.stringify(
          {
            name: 'smart-app',
            private: true,
            type: 'module',
            scripts: {
              build:
                "node -e \"require('fs').cpSync('public','dist',{recursive:true})\"",
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'public/index.html',
        content:
          '<!doctype html><html><head><meta charset="utf-8"><title>SMART Patient Viewer</title></head><body><h1>SMART Patient Viewer</h1><pre id="result">Launching…</pre><script type="module" src="./app.js"></script></body></html>',
      },
      { path: 'public/smart.js', content: smart },
      {
        path: 'public/app.js',
        content:
          "import {launch} from './smart.js'; launch().then(data=>document.querySelector('#result').textContent=JSON.stringify(data,null,2)).catch(error=>document.querySelector('#result').textContent=error.message);",
      },
    ];
  if (kind === 'react')
    return [
      readme,
      {
        path: 'package.json',
        content: JSON.stringify(
          {
            name: 'smart-react',
            private: true,
            type: 'module',
            scripts: { build: 'vite build' },
            dependencies: { react: '^19.3.1', 'react-dom': '^19.3.1' },
            devDependencies: { vite: '^8.3.4', typescript: '^6.0.0' },
          },
          null,
          2,
        ),
      },
      {
        path: 'index.html',
        content:
          '<!doctype html><html><head><meta charset="utf-8"><title>SMART Patient Viewer</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
      },
      { path: 'src/smart.js', content: smart },
      {
        path: 'src/main.tsx',
        content:
          "import React, {useState,useEffect} from 'react'; import {createRoot} from 'react-dom/client'; import {launch} from './smart.js'; function App(){const [result,setResult]=useState('Launching…');useEffect(()=>{launch().then(v=>setResult(JSON.stringify(v,null,2))).catch(e=>setResult(e.message))},[]);return <main><h1>SMART Patient Viewer</h1><pre>{result}</pre></main>} createRoot(document.getElementById('root')!).render(<App/>);",
      },
    ];
  if (kind === 'angular')
    return [
      readme,
      {
        path: 'package.json',
        content: JSON.stringify(
          {
            name: 'smart-angular',
            private: true,
            scripts: { build: 'ng build' },
            dependencies: {
              '@angular/common': '^22.2.3',
              '@angular/compiler': '^22.2.3',
              '@angular/core': '^22.2.3',
              '@angular/platform-browser': '^22.2.3',
              rxjs: '~7.8.2',
              tslib: '^2.8.1',
            },
            devDependencies: {
              '@angular/build': '^22.2.3',
              '@angular/cli': '^22.2.3',
              '@angular/compiler-cli': '^22.2.3',
              typescript: '<7',
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'angular.json',
        content: JSON.stringify(
          {
            version: 1,
            projects: {
              app: {
                projectType: 'application',
                root: '',
                sourceRoot: 'src',
                architect: {
                  build: {
                    builder: '@angular/build:application',
                    options: {
                      browser: 'src/main.ts',
                      index: 'src/index.html',
                      tsConfig: 'tsconfig.json',
                      outputPath: 'dist',
                      styles: [],
                      assets: [],
                    },
                  },
                },
              },
            },
          },
          null,
          2,
        ),
      },
      {
        path: 'tsconfig.json',
        content: JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'preserve',
              moduleResolution: 'bundler',
              experimentalDecorators: true,
              allowJs: true,
              strict: true,
              skipLibCheck: true,
            },
            angularCompilerOptions: { strictTemplates: true },
            files: ['src/main.ts'],
          },
          null,
          2,
        ),
      },
      {
        path: 'src/index.html',
        content:
          '<!doctype html><html><head><meta charset="utf-8"><title>SMART Patient Viewer</title><base href="/"></head><body><app-root></app-root></body></html>',
      },
      { path: 'src/smart.js', content: smart },
      {
        path: 'src/main.ts',
        content:
          "import {Component,signal,provideZonelessChangeDetection} from '@angular/core';import {bootstrapApplication} from '@angular/platform-browser';import {launch} from './smart.js';@Component({selector:'app-root',standalone:true,template:'<h1>SMART Patient Viewer</h1><pre>{{result()}}</pre>'})class App {result=signal('Launching…');constructor(){launch().then(v=>this.result.set(JSON.stringify(v,null,2))).catch((e:Error)=>this.result.set(e.message));}}bootstrapApplication(App,{providers:[provideZonelessChangeDetection()]});",
      },
    ];
  throw new Error('Unknown curated template.');
}
