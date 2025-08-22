#!/bin/bash

# health-check.sh - Comprehensive health check script for blue-green deployments
set -euo pipefail

# Configuration
HEALTH_ENDPOINT="${HEALTH_ENDPOINT:-http://localhost:3000/api/health}"
METRICS_ENDPOINT="${METRICS_ENDPOINT:-http://localhost:3000/metrics}"
TIMEOUT="${TIMEOUT:-10}"
MAX_RETRIES="${MAX_RETRIES:-5}"
RETRY_INTERVAL="${RETRY_INTERVAL:-5}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Basic health check
check_basic_health() {
    local endpoint="$1"
    local timeout="$2"
    
    log_info "Checking basic health at $endpoint"
    
    local response
    if response=$(curl -f -m "$timeout" -s "$endpoint" 2>/dev/null); then
        local status=$(echo "$response" | jq -r '.ok // false' 2>/dev/null || echo "false")
        
        if [ "$status" = "true" ]; then
            log_success "Basic health check passed"
            return 0
        else
            log_error "Health check returned unhealthy status"
            return 1
        fi
    else
        log_error "Health check endpoint unreachable"
        return 1
    fi
}

# Detailed health check
check_detailed_health() {
    local endpoint="$1"
    local timeout="$2"
    
    log_info "Running detailed health checks"
    
    local response
    if response=$(curl -f -m "$timeout" -s "$endpoint/detailed" 2>/dev/null); then
        # Parse detailed health response
        local db_status=$(echo "$response" | jq -r '.database.status // "unknown"' 2>/dev/null || echo "unknown")
        local redis_status=$(echo "$response" | jq -r '.redis // "unknown"' 2>/dev/null || echo "unknown")
        local queue_status=$(echo "$response" | jq -r '.queues // "unknown"' 2>/dev/null || echo "unknown")
        
        log_info "Database: $db_status"
        log_info "Redis: $redis_status"
        log_info "Queues: $queue_status"
        
        if [ "$db_status" = "connected" ] && [ "$redis_status" = "connected" ]; then
            log_success "Detailed health check passed"
            return 0
        else
            log_error "Detailed health check failed"
            return 1
        fi
    else
        log_warning "Detailed health endpoint not available"
        return 0  # Don't fail if detailed endpoint doesn't exist
    fi
}

# Check API functionality
check_api_functionality() {
    local base_url="$1"
    local timeout="$2"
    
    log_info "Testing API functionality"
    
    # Test translation endpoint
    local translation_response
    if translation_response=$(curl -f -m "$timeout" -s -X POST "$base_url/api/translate" \
        -H "Content-Type: application/json" \
        -d '{"text":"Hello","mode":"formal","targetLanguage":"French"}' 2>/dev/null); then
        
        local result=$(echo "$translation_response" | jq -r '.result // ""' 2>/dev/null || echo "")
        
        if [ -n "$result" ] && [ "$result" != "null" ]; then
            log_success "Translation API test passed"
        else
            log_warning "Translation API returned empty result (may be due to missing API key)"
        fi
    else
        log_warning "Translation API test failed (expected in health check mode)"
    fi
    
    # Test metrics endpoint
    if curl -f -m "$timeout" -s "$METRICS_ENDPOINT" > /dev/null 2>&1; then
        log_success "Metrics endpoint accessible"
    else
        log_warning "Metrics endpoint not accessible"
    fi
    
    return 0
}

# Check resource usage
check_resource_usage() {
    log_info "Checking resource usage"
    
    # Memory usage
    if command -v free &> /dev/null; then
        local mem_usage=$(free | grep Mem | awk '{printf "%.1f", $3/$2 * 100.0}')
        log_info "Memory usage: ${mem_usage}%"
        
        if (( $(echo "$mem_usage > 90" | bc -l) )); then
            log_warning "High memory usage: ${mem_usage}%"
        fi
    fi
    
    # CPU usage
    if command -v top &> /dev/null; then
        local cpu_usage=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | sed 's/%us,//')
        log_info "CPU usage: ${cpu_usage}%"
    fi
    
    # Disk usage
    if command -v df &> /dev/null; then
        local disk_usage=$(df -h / | awk 'NR==2{printf "%s", $5}')
        log_info "Disk usage: $disk_usage"
        
        local disk_percent=$(echo "$disk_usage" | sed 's/%//')
        if [ "$disk_percent" -gt 85 ]; then
            log_warning "High disk usage: $disk_usage"
        fi
    fi
}

# Check deployment status (for Kubernetes)
check_k8s_deployment_status() {
    local namespace="${NAMESPACE:-localization-app}"
    
    if ! command -v kubectl &> /dev/null; then
        log_info "kubectl not available, skipping Kubernetes checks"
        return 0
    fi
    
    log_info "Checking Kubernetes deployment status"
    
    # Check deployment rollout status
    if kubectl rollout status deployment/localization-app -n "$namespace" --timeout=60s &> /dev/null; then
        log_success "Kubernetes deployment is ready"
    else
        log_error "Kubernetes deployment is not ready"
        return 1
    fi
    
    # Check pod status
    local ready_pods=$(kubectl get pods -n "$namespace" -l app=localization-app --field-selector=status.phase=Running -o json | jq '.items | length')
    local total_pods=$(kubectl get pods -n "$namespace" -l app=localization-app -o json | jq '.items | length')
    
    log_info "Ready pods: $ready_pods/$total_pods"
    
    if [ "$ready_pods" -gt 0 ]; then
        log_success "At least one pod is running"
    else
        log_error "No pods are running"
        return 1
    fi
    
    return 0
}

# Main health check function
main() {
    local exit_code=0
    local check_type="${1:-full}"
    
    log_info "Starting health check (type: $check_type)"
    log_info "Target: $HEALTH_ENDPOINT"
    
    case "$check_type" in
        basic)
            for ((i=1; i<=MAX_RETRIES; i++)); do
                if check_basic_health "$HEALTH_ENDPOINT" "$TIMEOUT"; then
                    log_success "Basic health check completed successfully"
                    exit 0
                fi
                
                if [ $i -lt $MAX_RETRIES ]; then
                    log_warning "Health check failed, retrying in ${RETRY_INTERVAL}s (attempt $i/$MAX_RETRIES)"
                    sleep "$RETRY_INTERVAL"
                fi
            done
            
            log_error "Basic health check failed after $MAX_RETRIES attempts"
            exit 1
            ;;
            
        api)
            check_api_functionality "$(dirname "$HEALTH_ENDPOINT")" "$TIMEOUT" || exit_code=1
            ;;
            
        resources)
            check_resource_usage || exit_code=1
            ;;
            
        k8s)
            check_k8s_deployment_status || exit_code=1
            ;;
            
        full|*)
            # Run all checks
            for ((i=1; i<=MAX_RETRIES; i++)); do
                if check_basic_health "$HEALTH_ENDPOINT" "$TIMEOUT"; then
                    break
                fi
                
                if [ $i -lt $MAX_RETRIES ]; then
                    log_warning "Basic health check failed, retrying in ${RETRY_INTERVAL}s (attempt $i/$MAX_RETRIES)"
                    sleep "$RETRY_INTERVAL"
                else
                    log_error "Basic health check failed after $MAX_RETRIES attempts"
                    exit 1
                fi
            done
            
            check_detailed_health "$HEALTH_ENDPOINT" "$TIMEOUT" || exit_code=1
            check_api_functionality "$(dirname "$HEALTH_ENDPOINT")" "$TIMEOUT" || exit_code=1
            check_resource_usage || exit_code=1
            check_k8s_deployment_status || exit_code=1
            ;;
    esac
    
    if [ $exit_code -eq 0 ]; then
        log_success "All health checks completed successfully"
    else
        log_error "Some health checks failed"
    fi
    
    exit $exit_code
}

# Handle command line arguments
case "${1:-full}" in
    basic|api|resources|k8s|full)
        main "$1"
        ;;
    *)
        echo "Usage: $0 {basic|api|resources|k8s|full}"
        echo ""
        echo "Environment variables:"
        echo "  HEALTH_ENDPOINT=http://localhost:3000/api/health"
        echo "  TIMEOUT=10                    # Request timeout in seconds"
        echo "  MAX_RETRIES=5                 # Number of retry attempts"
        echo "  RETRY_INTERVAL=5              # Seconds between retries"
        echo "  NAMESPACE=localization-app    # Kubernetes namespace"
        exit 1
        ;;
esac
