import asyncio
import json
import random
from typing import Dict, Optional, Tuple, Any
from fastapi import WebSocket
from sqlalchemy.orm import Session
from backend.database import SessionLocal
from backend.models import Match, User, Question

class MatchSession:
    """
    Represents an active 1v1 match room session on the server.
    Manages client WebSocket connections, ready states, timer task, and tab blur (forfeit) tasks.
    """
    def __init__(self, match_id: int):
        self.match_id = match_id
        # Maps user_id -> WebSocket connection
        self.connections: Dict[int, WebSocket] = {}
        # Maps user_id -> is_ready (bool)
        self.ready_states: Dict[int, bool] = {}
        # Maps user_id -> is_blurred (bool) to track if they left the LeetCode tab
        self.blurred_states: Dict[int, bool] = {}
        # Main countdown timer task (15 minutes)
        self.timer_task: Optional[asyncio.Task] = None
        # Maps user_id -> blur forfeit timer task (15 seconds warning)
        self.blur_tasks: Dict[int, asyncio.Task] = {}
        # Total seconds left in the race (15 mins = 900 seconds)
        self.seconds_left = 900
        self.is_active = False


class ConnectionManager:
    """
    Manages all active MatchSessions, handles routing of incoming WebSocket messages,
    manages timer count-downs, and broadcasts event updates to players.
    """
    def __init__(self):
        # Maps match_id -> MatchSession
        self.sessions: Dict[int, MatchSession] = {}

    def get_or_create_session(self, match_id: int) -> MatchSession:
        if match_id not in self.sessions:
            self.sessions[match_id] = MatchSession(match_id)
        return self.sessions[match_id]

    async def connect(self, websocket: WebSocket, match_id: int, user_id: int):
        """
        Accepts a WebSocket connection and registers the user to the match room.
        Supports reconnection for active matches.
        """
        await websocket.accept()
        session = self.get_or_create_session(match_id)
        session.connections[user_id] = websocket
        
        # Check if the match is already active in database (reconnection support)
        db = SessionLocal()
        try:
            match = db.query(Match).filter(Match.id == match_id).first()
            if match and match.status == "ACTIVE":
                session.is_active = True
                # Send sync state message to reconnecting player
                await websocket.send_json({
                    "type": "SYNC_STATE",
                    "status": "ACTIVE",
                    "seconds_left": session.seconds_left,
                    "question_url": match.question.url if match.question else "",
                    "question_title": match.question.title if match.question else ""
                })
            else:
                session.ready_states.setdefault(user_id, False)
                await self.broadcast_lobby_state(match_id)
        finally:
            db.close()

    def disconnect(self, match_id: int, user_id: int):
        """
        Cleans up connection references and cancels active tasks for a disconnected user.
        """
        if match_id in self.sessions:
            session = self.sessions[match_id]
            if user_id in session.connections:
                del session.connections[user_id]
            
            # Cancel any active blur/forfeit timer for this user
            if user_id in session.blur_tasks:
                session.blur_tasks[user_id].cancel()
                del session.blur_tasks[user_id]
                
            # If both players disconnected, clean up the session
            if not session.connections:
                db = SessionLocal()
                try:
                    match = db.query(Match).filter(Match.id == match_id).first()
                    if not match or match.status != "ACTIVE":
                        if session.timer_task:
                            session.timer_task.cancel()
                        del self.sessions[match_id]
                finally:
                    db.close()

    async def broadcast_to_session(self, match_id: int, message: Dict[str, Any]):
        """
        Sends a JSON message to all connected players in the match session.
        """
        if match_id in self.sessions:
            session = self.sessions[match_id]
            for user_id, websocket in list(session.connections.items()):
                try:
                    await websocket.send_json(message)
                except Exception:
                    # Broken connections are cleaned up on disconnect/WebSocketDisconnect
                    pass

    async def send_to_user(self, match_id: int, user_id: int, message: Dict[str, Any]):
        """
        Sends a JSON message to a specific user in the match session (e.g. for directed sabotages).
        """
        if match_id in self.sessions:
            session = self.sessions[match_id]
            websocket = session.connections.get(user_id)
            if websocket:
                try:
                    await websocket.send_json(message)
                except Exception:
                    pass

    async def broadcast_lobby_state(self, match_id: int):
        """
        Broadcasts the current lobby details (users, ELOs, ready states, connection statuses).
        """
        db = SessionLocal()
        try:
            match = db.query(Match).filter(Match.id == match_id).first()
            if not match:
                return
            session = self.get_or_create_session(match_id)
            
            players_info = []
            for player_id in [match.host_id, match.guest_id]:
                if player_id:
                    player = db.query(User).filter(User.id == player_id).first()
                    if player:
                        players_info.append({
                            "id": player.id,
                            "username": player.username,
                            "elo_rating": player.elo_rating,
                            "is_ready": session.ready_states.get(player.id, False),
                            "is_connected": player.id in session.connections
                        })
            
            await self.broadcast_to_session(match_id, {
                "type": "LOBBY_STATE",
                "match_id": match_id,
                "host_id": match.host_id,
                "guest_id": match.guest_id,
                "topic": match.striver_topic,
                "status": match.status,
                "players": players_info
            })
        finally:
            db.close()

    async def toggle_ready(self, match_id: int, user_id: int, is_ready: bool):
        """
        Toggles a user's ready status. Starts the match if both users are ready.
        """
        session = self.get_or_create_session(match_id)
        session.ready_states[user_id] = is_ready
        await self.broadcast_lobby_state(match_id)
        
        db = SessionLocal()
        try:
            match = db.query(Match).filter(Match.id == match_id).first()
            if match and match.status == "PENDING" and match.host_id and match.guest_id:
                host_ready = session.ready_states.get(match.host_id, False)
                guest_ready = session.ready_states.get(match.guest_id, False)
                
                if host_ready and guest_ready:
                    await self.start_match(match_id, db)
        finally:
            db.close()

    async def start_match(self, match_id: int, db: Session):
        """
        Transitions the match status to ACTIVE, picks a random question from
        the Striver topic, resets timers, and broadcasts the question URL.
        """
        session = self.get_or_create_session(match_id)
        match = db.query(Match).filter(Match.id == match_id).first()
        if not match:
            return
            
        questions = db.query(Question).filter(Question.striver_topic == match.striver_topic).all()
        if not questions:
            await self.broadcast_to_session(match_id, {
                "type": "ERROR",
                "message": f"No questions seeded for topic {match.striver_topic}"
            })
            return
            
        question = random.choice(questions)
        match.question_id = question.id
        match.status = "ACTIVE"
        db.commit()
        
        session.is_active = True
        session.seconds_left = 900
        
        # Start game timer countdown in background
        session.timer_task = asyncio.create_task(self.run_countdown_timer(match_id))
        
        await self.broadcast_to_session(match_id, {
            "type": "START_MATCH",
            "match_id": match_id,
            "question_id": question.id,
            "question_title": question.title,
            "question_difficulty": question.difficulty,
            "question_url": question.url
        })

    async def run_countdown_timer(self, match_id: int):
        """
        Counts down from 15 minutes (900 seconds) and broadcasts ticks to sync client UIs.
        """
        try:
            session = self.get_or_create_session(match_id)
            while session.seconds_left > 0:
                await asyncio.sleep(1)
                session.seconds_left -= 1
                await self.broadcast_to_session(match_id, {
                    "type": "TIMER_TICK",
                    "seconds_left": session.seconds_left
                })
            
            # Timer expired - Draw/Timeout
            await self.end_match_timeout(match_id)
        except asyncio.CancelledError:
            pass

    async def end_match_timeout(self, match_id: int):
        """
        Handles match finalization when the 15-minute timer expires.
        """
        db = SessionLocal()
        try:
            match = db.query(Match).filter(Match.id == match_id).first()
            if match and match.status == "ACTIVE":
                match.status = "COMPLETED"
                match.duration_seconds = 900
                
                # Update match counts
                for user_id in [match.host_id, match.guest_id]:
                    user = db.query(User).filter(User.id == user_id).first()
                    if user:
                        user.total_matches += 1
                        
                db.commit()
                
                await self.broadcast_to_session(match_id, {
                    "type": "MATCH_OVER",
                    "reason": "timeout",
                    "winner_id": None,
                    "winner_username": None
                })
        finally:
            db.close()
            self.cleanup_session(match_id)

    async def handle_submit_success(self, match_id: int, winner_id: int):
        """
        Triggered when a player's submission is intercepted and verified as 'Accepted'.
        Stops the countdown, calculates ELO changes, updates records, and broadcasts victory.
        """
        session = self.get_or_create_session(match_id)
        if not session.is_active:
            return
            
        db = SessionLocal()
        try:
            match = db.query(Match).filter(Match.id == match_id).first()
            if match and match.status == "ACTIVE":
                if session.timer_task:
                    session.timer_task.cancel()
                
                loser_id = match.guest_id if winner_id == match.host_id else match.host_id
                
                winner = db.query(User).filter(User.id == winner_id).first()
                loser = db.query(User).filter(User.id == loser_id).first()
                
                elo_updates = {}
                if winner and loser:
                    r_win_before = winner.elo_rating
                    r_lose_before = loser.elo_rating
                    
                    w_rating, l_rating = self.calculate_elo(r_win_before, r_lose_before, True)
                    
                    winner.elo_rating = w_rating
                    winner.total_wins += 1
                    winner.total_matches += 1
                    
                    loser.elo_rating = l_rating
                    loser.total_matches += 1
                    
                    elo_updates = {
                        winner.id: {"before": r_win_before, "after": w_rating, "change": w_rating - r_win_before},
                        loser.id: {"before": r_lose_before, "after": l_rating, "change": l_rating - r_lose_before}
                    }

                match.status = "COMPLETED"
                match.winner_id = winner_id
                match.duration_seconds = 900 - session.seconds_left
                db.commit()
                
                # Broadcast the "player_submitted_correctly" event to sync both clients
                await self.broadcast_to_session(match_id, {
                    "type": "player_submitted_correctly",
                    "winner_id": winner_id,
                    "winner_username": winner.username if winner else "Unknown",
                    "duration_seconds": match.duration_seconds,
                    "elo_updates": elo_updates
                })
        finally:
            db.close()
            self.cleanup_session(match_id)

    async def handle_player_blur(self, match_id: int, user_id: int, is_blurred: bool):
        """
        Tracks if a user has left the LeetCode tab. If blurred for more than 15 seconds,
        triggers forfeit.
        """
        session = self.get_or_create_session(match_id)
        if not session.is_active:
            return
            
        session.blurred_states[user_id] = is_blurred
        
        # Notify the opponent about blur status change
        db = SessionLocal()
        try:
            match = db.query(Match).filter(Match.id == match_id).first()
            if not match:
                return
            opponent_id = match.guest_id if user_id == match.host_id else match.host_id
            await self.send_to_user(match_id, opponent_id, {
                "type": "OPPONENT_BLUR",
                "is_blurred": is_blurred
            })
            
            if is_blurred:
                # Start 15-second forfeit countdown
                if user_id not in session.blur_tasks or session.blur_tasks[user_id].done():
                    session.blur_tasks[user_id] = asyncio.create_task(self.run_blur_forfeit_timer(match_id, user_id))
            else:
                # Cancel forfeit timer since user returned to tab
                if user_id in session.blur_tasks:
                    session.blur_tasks[user_id].cancel()
                    del session.blur_tasks[user_id]
        finally:
            db.close()

    async def run_blur_forfeit_timer(self, match_id: int, user_id: int):
        """
        Waits 15 seconds. If not cancelled, triggers forfeit victory for the opponent.
        """
        try:
            await asyncio.sleep(15)
            await self.handle_forfeit(match_id, user_id)
        except asyncio.CancelledError:
            pass

    async def handle_forfeit(self, match_id: int, forfeit_user_id: int):
        """
        Finishes match, awarding victory to the non-forfeiting opponent due to anti-cheat violation.
        """
        session = self.get_or_create_session(match_id)
        if not session.is_active:
            return
            
        db = SessionLocal()
        try:
            match = db.query(Match).filter(Match.id == match_id).first()
            if match and match.status == "ACTIVE":
                if session.timer_task:
                    session.timer_task.cancel()
                
                winner_id = match.guest_id if forfeit_user_id == match.host_id else match.host_id
                
                winner = db.query(User).filter(User.id == winner_id).first()
                loser = db.query(User).filter(User.id == forfeit_user_id).first()
                
                elo_updates = {}
                if winner and loser:
                    r_win_before = winner.elo_rating
                    r_lose_before = loser.elo_rating
                    
                    w_rating, l_rating = self.calculate_elo(r_win_before, r_lose_before, True)
                    
                    winner.elo_rating = w_rating
                    winner.total_wins += 1
                    winner.total_matches += 1
                    
                    loser.elo_rating = l_rating
                    loser.total_matches += 1
                    
                    elo_updates = {
                        winner.id: {"before": r_win_before, "after": w_rating, "change": w_rating - r_win_before},
                        loser.id: {"before": r_lose_before, "after": l_rating, "change": l_rating - r_lose_before}
                    }
                
                match.status = "FORFEITED"
                match.winner_id = winner_id
                match.duration_seconds = 900 - session.seconds_left
                db.commit()
                
                await self.broadcast_to_session(match_id, {
                    "type": "MATCH_OVER",
                    "reason": "forfeit",
                    "winner_id": winner_id,
                    "winner_username": winner.username if winner else "Unknown",
                    "forfeited_user_id": forfeit_user_id,
                    "elo_updates": elo_updates
                })
        finally:
            db.close()
            self.cleanup_session(match_id)

    async def handle_sabotage(self, match_id: int, sender_id: int, sabotage_type: str):
        """
        Handles sabotage activations. Relays the "sabotage_triggered" event to the opponent.
        """
        session = self.get_or_create_session(match_id)
        if not session.is_active:
            return
            
        db = SessionLocal()
        try:
            match = db.query(Match).filter(Match.id == match_id).first()
            if not match:
                return
            target_id = match.guest_id if sender_id == match.host_id else match.host_id
            
            # Broadcast the sabotage event to the opponent to trigger client-side disruption
            await self.send_to_user(match_id, target_id, {
                "type": "sabotage_triggered",
                "sabotage_type": sabotage_type,
                "sender_id": sender_id
            })
        finally:
            db.close()

    async def handle_typing_status(self, match_id: int, sender_id: int, is_coding: bool):
        """
        Relays the typing/coding status of one player to the other.
        """
        session = self.get_or_create_session(match_id)
        if not session.is_active:
            return
            
        db = SessionLocal()
        try:
            match = db.query(Match).filter(Match.id == match_id).first()
            if not match:
                return
            target_id = match.guest_id if sender_id == match.host_id else match.host_id
            
            await self.send_to_user(match_id, target_id, {
                "type": "OPPONENT_TYPING",
                "is_coding": is_coding
            })
        finally:
            db.close()

    def calculate_elo(self, rating_a: int, rating_b: int, a_won: bool, k: int = 32) -> Tuple[int, int]:
        """
        Calculates ELO changes based on match outcome.
        """
        expected_a = 1.0 / (1.0 + 10 ** ((rating_b - rating_a) / 400.0))
        expected_b = 1.0 / (1.0 + 10 ** ((rating_a - rating_b) / 400.0))
        
        score_a = 1.0 if a_won else 0.0
        score_b = 0.0 if a_won else 1.0
        
        new_rating_a = round(rating_a + k * (score_a - expected_a))
        new_rating_b = round(rating_b + k * (score_b - expected_b))
        
        return new_rating_a, new_rating_b

    def cleanup_session(self, match_id: int):
        """
        Cleans up task references for completed matches.
        """
        if match_id in self.sessions:
            session = self.sessions[match_id]
            session.is_active = False
            if session.timer_task:
                session.timer_task.cancel()
            for user_id, task in session.blur_tasks.items():
                task.cancel()
            session.blur_tasks.clear()

manager = ConnectionManager()
