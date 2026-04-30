# Docker Optimization & Deployment Guide

This document explains the technical details behind the optimization and deployment strategy for Doodle Duel, which solved the **2GB image size** issue and the **"No space left on device"** build errors.

## 1. Image Size Optimization

### Next.js Standalone Output
We enabled `output: 'standalone'` in `next.config.ts`. This uses **Output File Tracing** to analyze the code and bundle only the production-required files from `node_modules`.

*   **Result**: Removes hundreds of MBs of dev-dependencies (Tailwind, TypeScript, etc.) from the final image.

### Optimized Multi-Stage Dockerfile
We use a multi-stage build to keep the final image lean:
1.  **Builder Stage**: Installs all dependencies, generates Prisma clients, and builds the Next.js app.
2.  **Runner Stage**: Copies only the `.next/standalone` folder and static assets into a fresh `node:alpine` image.

---

## 2. CI/CD Optimization (GitHub Actions)

To solve the **Resource Exhaustion (ENOSPC)** errors on small EC2 instances (t2.micro/t3.micro), we moved the build process away from the server.

### The Problem with Local Builds
Small servers have limited RAM (~1GB) and Disk (~8GB). Running `npm install` and `next build` exhausts these resources, causing the build to crash.

### The Solution: Build-and-Push Workflow
We use **GitHub Actions** as our build farm:
1.  **Remote Build**: GitHub provides a high-performance VM (14GB RAM) to build the Docker image.
2.  **Registry Push**: The finished image is pushed to **Docker Hub**.
3.  **Lightweight Deploy**: The EC2 instance simply pulls the pre-built image and runs it.

---

## 3. Deployment Flow

### Prerequisites (GitHub Secrets)
Ensure the following secrets are set in your GitHub repository:
*   `DOCKERHUB_USERNAME`: Your Docker Hub username.
*   `DOCKERHUB_TOKEN`: Access token from Docker Hub.
*   `EC2_HOST`: Server IP address.
*   `EC2_USER`: Usually `root` or `ubuntu`.
*   `EC2_PRIVATE_KEY`: Your SSH `.pem` key.

### Deployment Commands
The deployment is fully automated via `.github/workflows/deploy.yml`. When you push to `main`:
1.  GitHub builds the image: `docker build -t user/doodleduel .`
2.  GitHub pushes to Hub: `docker push user/doodleduel`
3.  GitHub SSHs into EC2 and runs:
    ```bash
    docker compose pull
    docker compose up -d
    ```

## 4. Performance Summary

| Metric | Before | After |
| :--- | :--- | :--- |
| **Image Size** | ~2.0 GB | ~250 MB |
| **Server Load** | 100% (Builds crashed) | <10% (Just running) |
| **Deploy Time** | ~10 mins (Failed often) | ~2 mins (Reliable) |
| **Disk Usage** | Exhausted | Clean |
