# Community example applications

This directory contains user-contributed and maintained SMART on FHIR example apps.
They deploy separately and do not ship with FHIR Studio images.

Projects may use any framework or source layout, but must commit a directory of
ready-to-serve static assets, such as `public/` or `dist/`, for FHIR Studio to deploy.
Developers run any compilation or bundling in their own development environment or
CI and commit the resulting assets. Studio imports the selected directory directly;
it does not install dependencies, run build commands, or install GitHub workflows.

Each project must include its own `README.md` explaining what the app does, how to
build it, where its static output is located, and how to configure and launch it in
FHIR Studio.

See the [application hosting guide](../doc/application-hosting.md) for deployment
details.
