#!/bin/bash
# ============================================
# Photobooth Deployment Script
# ============================================
# Run this on a fresh Ubuntu 22.04+ server.
# Usage: chmod +x deploy.sh && ./deploy.sh
# ============================================

set -e

echo "======================================"
echo " Photobooth - Server Setup"
echo "======================================"

# --- 1. System Updates ---
echo "[1/5] Updating system packages..."
sudo apt-get update -y
sudo apt-get upgrade -y

# --- 2. Install Docker ---
echo "[2/5] Installing Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker $USER
    echo "Docker installed. You may need to log out and back in for group changes."
else
    echo "Docker already installed."
fi

# --- 3. Install Docker Compose ---
echo "[3/5] Installing Docker Compose..."
if ! command -v docker compose &> /dev/null; then
    sudo apt-get install -y docker-compose-plugin
else
    echo "Docker Compose already installed."
fi

# --- 4. Open Firewall Ports ---
echo "[4/5] Configuring firewall..."
if command -v ufw &> /dev/null; then
    # Standard Ubuntu firewall (InterServer, DigitalOcean, Hetzner, etc.)
    sudo ufw allow 22/tcp    # SSH — always allow first!
    sudo ufw allow 80/tcp    # HTTP
    sudo ufw allow 443/tcp   # HTTPS
    sudo ufw allow 8000/tcp  # Backend (direct access, optional)
    sudo ufw --force enable
    echo "UFW firewall configured."
else
    # Fallback: iptables (Oracle Cloud, legacy setups)
    sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
    sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
    sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 8000 -j ACCEPT
    if command -v netfilter-persistent &> /dev/null; then
        sudo netfilter-persistent save
    else
        sudo apt-get install -y iptables-persistent
        sudo netfilter-persistent save
    fi
    echo "iptables firewall configured."
fi

# --- 5. Create .env if not exists ---
echo "[5/5] Checking configuration..."
if [ ! -f backend/.env ]; then
    echo ""
    echo "⚠️  No backend/.env found!"
    echo "   Copy backend/.env.example to backend/.env and fill in your values:"
    echo "   cp backend/.env.example backend/.env"
    echo "   nano backend/.env"
    echo ""
    exit 1
fi

echo ""
echo "======================================"
echo " Setup Complete!"
echo "======================================"
echo ""
echo " To start the application:"
echo "   docker compose up -d --build"
echo ""
echo " To view logs:"
echo "   docker compose logs -f"
echo ""
echo " To stop:"
echo "   docker compose down"
echo ""
echo " The app will be available at:"
echo "   http://$(curl -s ifconfig.me)"
echo ""
