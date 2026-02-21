import requests

API_URL = "http://localhost:8000/api/generate"
# Use a dummy image (1x1 pixel) for testing
dummy_image = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82'

def test_frame_mode():
    files = {
        'photos': ('test.png', dummy_image, 'image/png')
    }
    data = {
        'template_id': 'happy-birthday',
        'processing_mode': 'frame'
    }
    
    print(f"Sending request to {API_URL} with mode=frame...")
    try:
        response = requests.post(API_URL, files=files, data=data)
        print(f"Status Code: {response.status_code}")
        print(f"Response: {response.text}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    test_frame_mode()
