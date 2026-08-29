-- Initialize databases for Authentik, FHIR Studio, and HAPI FHIR instances
CREATE DATABASE authentik;
CREATE DATABASE fhir_studio_development;
CREATE DATABASE hapi_r4;
CREATE DATABASE hapi_r4b;
CREATE DATABASE hapi_r5;

GRANT ALL PRIVILEGES ON DATABASE fhir_studio_development TO postgres;
GRANT ALL PRIVILEGES ON DATABASE authentik TO postgres;
GRANT ALL PRIVILEGES ON DATABASE hapi_r4 TO postgres;
GRANT ALL PRIVILEGES ON DATABASE hapi_r4b TO postgres;
GRANT ALL PRIVILEGES ON DATABASE hapi_r5 TO postgres;

