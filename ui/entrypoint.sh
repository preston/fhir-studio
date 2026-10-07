#!/bin/sh
set -eu
envsubst < configuration.template.js > configuration.js
exec nginx -g 'daemon off;'
