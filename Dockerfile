# Use official Node.js image for building
FROM node:22.19.0-bookworm AS builder

WORKDIR /app

# Install dependencies with Yarn
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn
RUN corepack enable \
	&& yarn install --immutable

# Copy the rest of the source code and build the app
COPY . .
RUN yarn build

# Use a lightweight image for running the app
FROM node:22.19.0-slim

WORKDIR /app

# Provide Yarn runtime configuration and binaries
COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn ./.yarn
RUN corepack enable

# Copy built output
COPY --from=builder /app/dist ./dist

# Expose port for the static server
EXPOSE 3000

# Serve the built assets with a static file server
CMD ["yarn", "dlx", "http-server", "dist", "-p", "3000", "-a", "0.0.0.0", "-c-1"]