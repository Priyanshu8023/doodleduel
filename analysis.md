# Skribbl Clone: Codebase Analysis and Improvement Plan

This document outlines an analysis of the current Skribbl clone repository and provides actionable recommendations to improve performance, scalability, user experience, and overall code quality.

## 1. Backend Architecture & Game Logic

The backend logic primarily resides in `gameState.ts` and socket handlers. While it is functional, there are several race conditions and edge cases that should be addressed.

### **Areas for Improvement:**
- [x] **Robust Disconnect Handling:** Currently, in `gameState.ts`, `drawerIndex` is an integer index. If a player disconnects, it shifts the indexes of players, potentially causing the wrong person to become the drawer or skipping someone's turn.
  - **Fix:** Use `drawerId` (a string matching the socket id) instead of `drawerIndex`. Also implemented **Player Reconnect** to resume session on refresh.
- [ ] **Dangling Timers:** `endRound` sets a 5-second `setTimeout` to start the next round. If the last player leaves during these 5 seconds, the server will try to access an empty room or start a round with no players.
  - **Fix:** Ensure timeouts and intervals are strictly cleared if the room becomes empty, and check if `room.players.length >= 2` before starting the next round inside the timeout.
- [ ] **Data Validation & Sanitization:** There's no limit to the length of chat messages or user names. Malicious users can send massive strings that consume server memory.
  - **Fix:** Add length validation on `chat_message` and `join_room` events.
- [ ] **Centralized Word List:** The word list is hardcoded in `gameState.ts` (`const WORDS = [...]`). 
  - **Fix:** Move this to a separate file (e.g., `lib/words.json` or a database table via Prisma) to easily expand the game's dictionary without changing logic.

## 2. Frontend Implementations & Components

The frontend utilizes Next.js with React hooks to manage socket connections and game state.

### **Areas for Improvement:**
- [ ] **Canvas Scaling and Responsiveness (`DrawingCanvas.tsx`):** The canvas size is hardcoded to `800x500`. If a player views this on a mobile device, their drawing coordinates will be skewed compared to someone on a desktop.
  - **Fix:** Normalize coordinates before emitting them (e.g., send percentage-based coordinates `x / width` and `y / height`) and scale them back on the receiving end.
- [ ] **Chat History Memory Leak (`ChatSection.tsx`):** The chat window continuously appends messages via `setChat((prev) => [...prev, msg])`. Over a long game, this will severely slow down the DOM.
  - **Fix:** Cap the maximum number of chat messages kept in state (e.g., keep only the last 100 messages). 
- [ ] **Drawing Performance:** Emitting socket events every 16ms is good, but users with slow connections might experience choppy drawings.
  - **Fix:** Batch drawing points into an array and emit them in chunks, or use binary data/WebSockets optimizations if the load gets heavy.
- [ ] **Canvas Features:** There is no "Clear Canvas", "Undo", or "FillBucket" functionality.
  - **Fix:** Emit a `clear_canvas` socket event that wiping the context for everyone, and add an undo stack logic in the frontend.

## 3. General Architecture & DevOps

- [x] **State Management:** The backend relies entirely on an in-memory `GameStore` object. This means if the server crashes or restarts, all active games are lost.
  - **Fix:** Use **Redis** to store the room states. I see there's a `redis/` directory being set up; transitioning the game state to Redis will allow you to scale the backend horizontally across multiple instances using Socket.IO Redis Adapter.
- [ ] **Stale Rooms Cleanup:** If a game crashes or players somehow leave without triggering a `disconnect` event, rooms might remain permanently in memory.
  - **Fix:** Implement a background cron job or periodic cleanup function to delete rooms that have been inactive or empty for over an hour.

## 4. Suggested New Features

1. [ ] **Custom Word Lists:** Allow the room host to paste custom words when creating a lobby.
2. [x] **Brush Types and Tools:** Introduce changing brush sizes, eraser, and an explicit color palette.
3. [ ] **Sound Effects:** Add audio cues for correct guesses, round starts, timer ticking down, and round ending.
4. [ ] **Leaderboard & Authentication:** Since Prisma is installed in the project, integrate user authentication to track total wins, high scores, and persistent player profiles.
