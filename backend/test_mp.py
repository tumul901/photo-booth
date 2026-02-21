import sys
print(f"Python: {sys.version}")
try:
    import mediapipe as mp
    print(f"MediaPipe file: {mp.__file__}")
    print(f"Dir(mp): {dir(mp)}")
    try:
        print(f"Solutions: {mp.solutions}")
        from mediapipe.solutions import face_detection
        print("Success: mp.solutions.face_detection imported")
    except AttributeError as e:
        print(f"Error accessing solutions: {e}")
        # Try manual import
        try:
            import mediapipe.python.solutions.face_detection
            print("Success: mediapipe.python.solutions.face_detection imported directly")
        except ImportError as e2:
            print(f"Error importing python.solutions: {e2}")

except ImportError as e:
    print(f"ImportError: {e}")
