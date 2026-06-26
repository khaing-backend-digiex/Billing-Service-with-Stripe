# Stage 1: Build the application
FROM node:22-alpine AS builder

# Set the working directory
WORKDIR /app

# Copy package files to install dependencies
COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies needed for build)
RUN npm ci

# Copy the rest of the application source code
COPY . .

# Build the NestJS application
RUN npm run build

# Stage 2: Production image
FROM node:22-alpine AS production

# Set the working directory
WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install only production dependencies to keep the image size small
RUN npm ci --omit=dev

# Copy the built dist folder from the builder stage
COPY --from=builder /app/dist ./dist

# Expose the application port (typically 3000 for NestJS)
EXPOSE 3000

# Start the NestJS application
CMD ["npm", "run", "start:prod"]
