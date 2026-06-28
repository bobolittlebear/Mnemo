# Codex Context Snapshot

## Project Summary
AIQuickNote is a TypeScript Express application for note-taking and AI-assisted knowledge retrieval. The core value lies in combining personal notes with conversational AI and memory management.

## Current Architecture
- Express app initializes in src/app.ts
- Routes are mounted from src/routes
- Controllers are thin and focused on request/response
- Services own business logic
- Models are Mongoose schemas for persistent entities
- Redis is used for transient memory and chat context
- OpenAI-compatible endpoints handle AI generation

## Important Files
- src/app.ts
- src/routes/api.route.ts
- src/controllers/chat.controller.ts
- src/service/ai.service.ts
- src/util/shortTermMemory.ts
- src/middleware/memory.middleware.ts
- src/models/Note.ts
- src/models/Notebook.ts
- src/models/ChatMessage.ts

## Expected Behavior
- New features should preserve the current API style and error envelope
- Streaming chat should remain resilient and non-blocking
- Authentication and memory middleware should continue to work as a shared path
- Database models should use simple, explicit schemas and timestamps

## Recommended Workflow
1. Read the route and controller first
2. Trace the data flow into service and model layers
3. Keep changes minimal and localized
4. Verify behavior through build or targeted script execution
