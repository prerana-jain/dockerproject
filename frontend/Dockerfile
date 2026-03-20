# Frontend Dockerfile
# Uses nginx:alpine; envsubst ships with it via gettext-tiny.
FROM nginx:alpine

# Remove default config
RUN rm /etc/nginx/conf.d/default.conf

# Copy template + static files
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY index.html          /usr/share/nginx/html/index.html

# The official nginx:alpine image automatically runs envsubst on
# /etc/nginx/templates/*.template → /etc/nginx/conf.d/*.conf
# at container start, using environment variables.
# See: https://hub.docker.com/_/nginx  "Using environment variables in nginx configuration"

EXPOSE 80

# Default CMD from base image: ["nginx", "-g", "daemon off;"]
