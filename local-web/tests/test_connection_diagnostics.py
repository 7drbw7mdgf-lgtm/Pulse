import unittest
from unittest.mock import patch
import test_library_save
from pulse_core import connection_diagnostics as doctor
from pulse_core.constants import ClientError

class ConnectionDiagnosticsTests(unittest.TestCase):
    def test_auth_rate_limit_and_transport_failures_have_distinct_safe_actions(self):
        error=ClientError(401,'application authentication failed SECRET');error.mendeley_stage='client-auth';error.mendeley_code='client-rejected'
        self.assertEqual(doctor.classify_error(error)['code'],'application_credentials')
        self.assertEqual(doctor.classify_error(ClientError(401,'SECRET'))['code'],'sign_in_expired')
        self.assertEqual(doctor.classify_error(ClientError(429,'SECRET'))['code'],'rate_limited')
        self.assertEqual(doctor.classify_error(ClientError(406,'SECRET'))['code'],'api_format')
        self.assertNotIn('SECRET',str(doctor.classify_error(error)))
    def test_profile_check_uses_profile_media_type_without_exposing_token(self):
        with patch.object(doctor.managers,'read_config',return_value={'accessToken':'PRIVATE','authFlow':'exchange'}),patch.object(doctor.managers,'access_token',return_value='PRIVATE'),patch.object(doctor.managers,'request',return_value={}) as request:
            result=doctor.check_mendeley()
        self.assertEqual(result['status'],'ok');self.assertNotIn('PRIVATE',str(result))
        self.assertEqual(request.call_args.kwargs['headers']['Accept'],'application/vnd.mendeley-profiles.1+json')
        self.assertEqual(request.call_args.args[0],doctor.managers.MENDELEY+'/profiles/me')
    def test_disconnected_check_does_not_attempt_authentication(self):
        with patch.object(doctor.managers,'read_config',return_value={}),patch.object(doctor.managers,'request') as request:
            self.assertEqual(doctor.check_mendeley()['code'],'not_connected');request.assert_not_called()
