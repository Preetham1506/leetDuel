import os
from fastapi import FastAPI, Depends, HTTPException, status, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from typing import List, Optional
from datetime import datetime

from backend.database import Base, engine, get_db, SessionLocal
from backend.models import User, Question, Match
from backend.schemas import UserCreate, UserResponse, Token, MatchCreate, MatchResponse
from backend.auth import get_password_hash, verify_password, create_access_token, get_current_user, verify_ws_token
from backend.manager import manager

app = FastAPI(title="LeetRace API")

# Setup CORS (Read FRONTEND_URL from environment variables for production)
FRONTEND_URL = os.getenv("FRONTEND_URL", "*")
origins = [o.strip() for o in FRONTEND_URL.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True if "*" not in origins else False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def startup_event():
    # Automatically create tables in MySQL on start
    print("Initializing database tables...")
    Base.metadata.create_all(bind=engine)

# --- Authentication Routes ---

@app.post("/api/auth/register", response_model=UserResponse)
def register(user_in: UserCreate, db: Session = Depends(get_db)):
    db_user = db.query(User).filter(User.username == user_in.username).first()
    if db_user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Username already registered"
        )
    
    hashed_password = get_password_hash(user_in.password)
    new_user = User(
        username=user_in.username,
        password_hash=hashed_password
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return new_user

@app.post("/api/auth/login", response_model=Token)
def login(user_in: UserCreate, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == user_in.username).first()
    if not user or not verify_password(user_in.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    access_token = create_access_token(
        data={"sub": user.username, "user_id": user.id}
    )
    return {"access_token": access_token, "token_type": "bearer"}

@app.get("/api/auth/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)):
    return current_user

# --- Leaderboard Route ---

@app.get("/api/leaderboard", response_model=List[UserResponse])
def get_leaderboard(db: Session = Depends(get_db)):
    return db.query(User).order_by(User.elo_rating.desc()).limit(50).all()

# --- Question Routes ---

@app.get("/api/questions/topics", response_model=List[str])
def get_topics(db: Session = Depends(get_db)):
    topics = db.query(Question.striver_topic).distinct().all()
    return [t[0] for t in topics]

# --- Match Routes ---

@app.post("/api/matches/create", response_model=MatchResponse)
def create_match(match_in: MatchCreate, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    # Check if user is already in an active match
    active_match = db.query(Match).filter(
        (Match.host_id == current_user.id) | (Match.guest_id == current_user.id),
        Match.status.in_(["PENDING", "ACTIVE"])
    ).first()
    
    if active_match:
        # Instead of failing, return the active match
        return active_match

    new_match = Match(
        host_id=current_user.id,
        striver_topic=match_in.striver_topic,
        status="PENDING"
    )
    db.add(new_match)
    db.commit()
    db.refresh(new_match)
    return new_match

@app.post("/api/matches/join/{match_id}", response_model=MatchResponse)
async def join_match(match_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    match = db.query(Match).filter(Match.id == match_id).first()
    if not match:
        raise HTTPException(status_code=404, detail="Match not found")
        
    if match.status != "PENDING":
        raise HTTPException(status_code=400, detail="Match is already started or completed")
        
    if match.host_id == current_user.id:
        return match # Already host
        
    match.guest_id = current_user.id
    db.commit()
    db.refresh(match)
    
    # Notify lobby that guest joined
    await manager.broadcast_lobby_state(match_id)
    return match

@app.get("/api/matches/active", response_model=Optional[MatchResponse])
def get_active_match(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    match = db.query(Match).filter(
        (Match.host_id == current_user.id) | (Match.guest_id == current_user.id),
        Match.status.in_(["PENDING", "ACTIVE"])
    ).first()
    return match

@app.post("/api/matches/leave/{match_id}", response_model=MatchResponse)
async def leave_match(match_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    match = db.query(Match).filter(Match.id == match_id).first()
    if not match:
        raise HTTPException(status_code=404, detail="Match not found")
        
    if match.status == "ACTIVE":
        # Leaving an active match forfeits it
        await manager.handle_forfeit(match_id, current_user.id)
        db.refresh(match)
        return match
        
    if match.status != "PENDING":
        raise HTTPException(status_code=400, detail="Match is already active or completed")
        
    if match.host_id == current_user.id:
        match.status = "ABANDONED"
        db.commit()
        db.refresh(match)
        await manager.broadcast_lobby_state(match_id)
    elif match.guest_id == current_user.id:
        match.guest_id = None
        db.commit()
        db.refresh(match)
        await manager.broadcast_lobby_state(match_id)
    else:
        raise HTTPException(status_code=400, detail="User is not in this match")
        
    return match

@app.get("/api/matches/history", response_model=List[MatchResponse])
def get_match_history(db: Session = Depends(get_db)):
    return db.query(Match).filter(Match.status.in_(["COMPLETED", "FORFEITED"])).order_by(Match.created_at.desc()).limit(20).all()

# --- WebSockets Endpoint ---

@app.websocket("/ws/match/{match_id}")
async def websocket_endpoint(websocket: WebSocket, match_id: int, user_id: int, token: str):
    db = SessionLocal()
    user = verify_ws_token(token, db)
    db.close()
    
    if not user or user.id != user_id:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await manager.connect(websocket, match_id, user_id)
    try:
        while True:
            data = await websocket.receive_text()
            message = json_data = json_load(data)
            
            msg_type = message.get("type")
            if msg_type == "TOGGLE_READY":
                is_ready = message.get("ready", False)
                await manager.toggle_ready(match_id, user_id, is_ready)
            elif msg_type == "SUBMIT_SUCCESS":
                await manager.handle_submit_success(match_id, user_id)
            elif msg_type == "PLAYER_BLUR":
                is_blurred = message.get("is_blurred", False)
                await manager.handle_player_blur(match_id, user_id, is_blurred)
            elif msg_type == "TRIGGER_SABOTAGE":
                sabotage_type = message.get("sabotage_type")
                await manager.handle_sabotage(match_id, user_id, sabotage_type)
            elif msg_type == "TYPING_STATUS":
                is_coding = message.get("is_coding", False)
                await manager.handle_typing_status(match_id, user_id, is_coding)
                
    except WebSocketDisconnect:
        manager.disconnect(match_id, user_id)
        # Notify lobby update after disconnect
        await manager.broadcast_lobby_state(match_id)
    except Exception as e:
        print(f"WebSocket error: {e}")
        manager.disconnect(match_id, user_id)

def json_load(data: str):
    try:
        return json.loads(data)
    except Exception:
        return {}

import json
