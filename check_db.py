from backend.database import SessionLocal
from backend.models import Match, Question, User

db = SessionLocal()
try:
    print("--- USERS ---")
    users = db.query(User).all()
    for u in users:
        print(f"User ID: {u.id}, Username: {u.username}, ELO: {u.elo_rating}")
        
    print("\n--- QUESTIONS ---")
    q_count = db.query(Question).count()
    print(f"Total questions seeded: {q_count}")
    
    print("\n--- MATCHES ---")
    matches = db.query(Match).all()
    for m in matches:
        print(f"Match ID: {m.id}, Host: {m.host_id}, Guest: {m.guest_id}, Topic: {m.striver_topic}, Status: {m.status}, Q: {m.question_id}")
finally:
    db.close()
