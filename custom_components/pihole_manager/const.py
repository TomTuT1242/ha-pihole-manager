"""Constants for the Pi-hole Manager integration."""

DOMAIN = "pihole_manager"

# Config keys
CONF_INSTANCES = "instances"
CONF_NAME = "name"
CONF_HOST = "host"
CONF_PORT = "port"
CONF_PASSWORD = "password"
CONF_USE_SSL = "use_ssl"
CONF_VERIFY_SSL = "verify_ssl"
CONF_SYNC_ENABLED = "sync_enabled"
CONF_WEBUI_URL = "webui_url"

# Defaults
DEFAULT_PORT = 80
DEFAULT_PORT_DOCKER = 8080
DEFAULT_USE_SSL = False
DEFAULT_VERIFY_SSL = True
DEFAULT_SYNC_ENABLED = True
DEFAULT_SCAN_INTERVAL = 300  # 5 minutes

# API paths
API_PATH = "/api"
API_AUTH = "/api/auth"
API_DOMAINS_DENY = "/api/domains/deny/exact"
API_DOMAINS_ALLOW = "/api/domains/allow/exact"
API_DNS = "/api/config/dns"
API_DNS_HOSTS = "/api/config/dns/hosts"
API_LISTS = "/api/lists"
API_STATS_SUMMARY = "/api/stats/summary"
API_DNS_BLOCKING = "/api/dns/blocking"
API_DOMAINS_DENY_REGEX = "/api/domains/deny/regex"
API_DOMAINS_ALLOW_REGEX = "/api/domains/allow/regex"
API_STATS_TOP_DOMAINS = "/api/stats/top_domains"
API_QUERIES = "/api/queries"
