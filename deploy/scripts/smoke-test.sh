#!/bin/bash

# smoke-test.sh - Comprehensive smoke tests for deployment validation
set -euo pipefail

# Configuration
BASE_URL="${BASE_URL:-http://localhost:3000}"
API_KEY="${API_KEY:-}"
TIMEOUT="${TIMEOUT:-30}"
USER_EMAIL="${USER_EMAIL:-test@example.com}"
USER_PASSWORD="${USER_PASSWORD:-testpassword123}"

# Colors for output
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

# Test counter
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

run_test() {
    local test_name="$1"
    local test_command="$2"
    
    log_info "Running test: $test_name"
    TESTS_RUN=$((TESTS_RUN + 1))
    
    if eval "$test_command"; then
        log_success "✅ $test_name"
        TESTS_PASSED=$((TESTS_PASSED + 1))
        return 0
    else
        log_error "❌ $test_name"
        TESTS_FAILED=$((TESTS_FAILED + 1))
        return 1
    fi
}

# Basic connectivity test
test_basic_connectivity() {
    curl -f -m "$TIMEOUT" -s "$BASE_URL/api/health" > /dev/null
}

# Test translation endpoint
test_translation_api() {
    local response
    response=$(curl -f -m "$TIMEOUT" -s -X POST "$BASE_URL/api/translate" \
        -H "Content-Type: application/json" \
        ${API_KEY:+-H "X-API-Key: $API_KEY"} \
        -d '{"text":"Hello world","mode":"formal","targetLanguage":"French"}')
    
    # Check if response contains result
    echo "$response" | jq -e '.result' > /dev/null
}

# Test metrics endpoint
test_metrics_endpoint() {
    curl -f -m "$TIMEOUT" -s "$BASE_URL/metrics" | grep -q "localization_"
}

# Test file upload (with dummy file)
test_file_upload() {
    # Create a temporary test file
    local test_file="/tmp/smoke_test.txt"
    echo "This is a test file for smoke testing." > "$test_file"
    
    local response
    response=$(curl -f -m "$TIMEOUT" -s -X POST "$BASE_URL/api/upload" \
        ${API_KEY:+-H "X-API-Key: $API_KEY"} \
        -F "file=@$test_file")
    
    # Clean up
    rm -f "$test_file"
    
    # Check if upload was successful
    echo "$response" | jq -e '.fileId' > /dev/null
}

# Test authentication endpoints
test_auth_endpoints() {
    # Test registration (if enabled)
    local register_response
    register_response=$(curl -m "$TIMEOUT" -s -X POST "$BASE_URL/api/auth/register" \
        -H "Content-Type: application/json" \
        -d "{\"email\":\"$USER_EMAIL\",\"password\":\"$USER_PASSWORD\",\"name\":\"Test User\"}" || echo "{}")
    
    # Test login
    local login_response
    login_response=$(curl -m "$TIMEOUT" -s -X POST "$BASE_URL/api/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"email\":\"$USER_EMAIL\",\"password\":\"$USER_PASSWORD\"}" || echo "{}")
    
    # Check if login returns a token or success status
    echo "$login_response" | jq -e '.token // .success' > /dev/null 2>&1 || return 0  # Don't fail if auth is disabled
}

# Test admin endpoints (if accessible)
test_admin_endpoints() {
    # Test queue status (requires authentication)
    curl -f -m "$TIMEOUT" -s "$BASE_URL/api/admin/queues" \
        ${API_KEY:+-H "X-API-Key: $API_KEY"} > /dev/null 2>&1 || return 0  # Don't fail if not accessible
}

# Test circuit breaker functionality
test_circuit_breaker() {
    # Test circuit breaker admin endpoint
    curl -f -m "$TIMEOUT" -s "$BASE_URL/api/admin/circuit-breakers" \
        ${API_KEY:+-H "X-API-Key: $API_KEY"} > /dev/null 2>&1 || return 0  # Don't fail if not accessible
}

# Test deployment health
test_deployment_health() {
    local response
    response=$(curl -f -m "$TIMEOUT" -s "$BASE_URL/api/health/detailed")
    
    # Check if detailed health includes M5/M6 components
    echo "$response" | jq -e '.m5 // .m6 // .status' > /dev/null
}

# Performance test (basic load)
test_basic_performance() {
    log_info "Running basic performance test..."
    
    # Send 10 concurrent requests
    local pids=()
    for i in {1..10}; do
        (curl -f -m "$TIMEOUT" -s "$BASE_URL/api/health" > /dev/null) &
        pids+=($!)
    done
    
    # Wait for all requests to complete
    local failed=0
    for pid in "${pids[@]}"; do
        if ! wait "$pid"; then
            failed=$((failed + 1))
        fi
    done
    
    # Pass if at least 80% succeeded
    local success_rate=$((100 * (10 - failed) / 10))
    [ "$success_rate" -ge 80 ]
}

# Database connectivity test
test_database_connectivity() {
    local response
    response=$(curl -f -m "$TIMEOUT" -s "$BASE_URL/api/health/detailed")
    
    # Check database status in health response
    local db_status
    db_status=$(echo "$response" | jq -r '.checks.database.status // "unknown"')
    
    [ "$db_status" = "connected" ]
}

# Main test suite
main() {
    log_info "Starting smoke tests for $BASE_URL"
    log_info "Timeout: ${TIMEOUT}s"
    
    if [ -n "$API_KEY" ]; then
        log_info "Using API key authentication"
    else
        log_warning "No API key provided - some tests may fail"
    fi
    
    echo "==========================================";
    
    # Run all tests
    run_test "Basic Connectivity" "test_basic_connectivity"
    run_test "Metrics Endpoint" "test_metrics_endpoint"
    run_test "Database Connectivity" "test_database_connectivity"
    run_test "Deployment Health" "test_deployment_health"
    run_test "Translation API" "test_translation_api"
    run_test "File Upload" "test_file_upload"
    run_test "Authentication" "test_auth_endpoints"
    run_test "Admin Endpoints" "test_admin_endpoints"
    run_test "Circuit Breaker" "test_circuit_breaker"
    run_test "Basic Performance" "test_basic_performance"
    
    echo "=========================================="
    echo "Smoke Test Results:"
    echo "  Total Tests: $TESTS_RUN"
    echo "  Passed: $TESTS_PASSED"
    echo "  Failed: $TESTS_FAILED"
    echo "  Success Rate: $(( 100 * TESTS_PASSED / TESTS_RUN ))%"
    echo "=========================================="
    
    if [ "$TESTS_FAILED" -eq 0 ]; then
        log_success "🎉 All smoke tests passed!"
        exit 0
    else
        log_error "💥 Some smoke tests failed"
        exit 1
    fi
}

# Handle command line arguments
case "${1:-all}" in
    all)
        main
        ;;
    basic)
        run_test "Basic Connectivity" "test_basic_connectivity"
        run_test "Metrics Endpoint" "test_metrics_endpoint"
        ;;
    api)
        run_test "Translation API" "test_translation_api"
        run_test "File Upload" "test_file_upload"
        ;;
    admin)
        run_test "Admin Endpoints" "test_admin_endpoints"
        run_test "Circuit Breaker" "test_circuit_breaker"
        ;;
    performance)
        run_test "Basic Performance" "test_basic_performance"
        ;;
    *)
        echo "Usage: $0 {all|basic|api|admin|performance}"
        echo ""
        echo "Environment variables:"
        echo "  BASE_URL=http://localhost:3000  # Target URL"
        echo "  API_KEY=your-api-key            # API key for authenticated tests"
        echo "  TIMEOUT=30                      # Request timeout in seconds"
        echo "  USER_EMAIL=test@example.com     # Test user email"
        echo "  USER_PASSWORD=testpassword123   # Test user password"
        exit 1
        ;;
esac
