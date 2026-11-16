import copy
import unittest

from activate_astrbot import paired_recipient, replace_env, require_idle


class PairingTests(unittest.TestCase):
    def setUp(self):
        self.confirmed = {'platform': {'id': 'loom-wechat', 'type': 'weixin_oc'},
                          'result': {'weixin_oc_user_id': 'verified-owner', 'weixin_oc_account_id': 'verified-bot'}}
        self.config = {'platform': [{'id': 'loom-wechat', 'type': 'weixin_oc', 'enable': True,
                                    'weixin_oc_account_id': 'verified-bot',
                                    'weixin_oc_context_tokens': {'someone-else': 'unrelated-context', 'verified-owner': 'owner-context'}}]}

    def test_recipient_comes_from_the_confirmed_owner_not_the_first_sender(self):
        self.assertEqual(paired_recipient(self.confirmed, self.config), 'loom-wechat:FriendMessage:verified-owner')

    def test_an_unrelated_senders_context_does_not_complete_pairing(self):
        del self.config['platform'][0]['weixin_oc_context_tokens']['verified-owner']
        with self.assertRaisesRegex(ValueError, 'private message'):
            paired_recipient(self.confirmed, self.config)

    def test_a_different_bot_account_is_rejected(self):
        self.config['platform'][0]['weixin_oc_account_id'] = 'another-bot'
        with self.assertRaisesRegex(ValueError, 'confirmed by QR'):
            paired_recipient(self.confirmed, self.config)

    def test_a_disabled_or_wrong_adapter_is_rejected(self):
        for field, value in [('enable', False), ('type', 'another-adapter')]:
            config = copy.deepcopy(self.config)
            config['platform'][0][field] = value
            with self.assertRaises(ValueError):
                paired_recipient(self.confirmed, config)

    def test_missing_or_ambiguous_owner_is_rejected(self):
        for owner in ['', 'owner:GroupMessage:other', 'owner\nother']:
            self.confirmed['result']['weixin_oc_user_id'] = owner
            with self.assertRaises(ValueError):
                paired_recipient(self.confirmed, self.config)

    def test_environment_update_preserves_other_keys_and_replaces_duplicates(self):
        original = b'SECRET=keep=unchanged\nFLAG=false\nFLAG=false\n'
        self.assertEqual(replace_env(original, {'FLAG': 'true'}), b'SECRET=keep=unchanged\nFLAG=true\n')

    def test_environment_update_rejects_injection(self):
        with self.assertRaises(ValueError):
            replace_env(b'SECRET=keep\n', {'FLAG': 'true\nSECRET=overwrite'})

    def test_active_or_unknown_job_states_block_recreation(self):
        for status in ['queued', 'claimed', 'running', 'waiting', 'unknown']:
            with self.assertRaises(ValueError):
                require_idle({'jobs': [{'status': status}], 'questions': []})
        require_idle({'jobs': [{'status': status} for status in ['succeeded', 'failed', 'cancelled', 'interrupted']], 'questions': []})

    def test_pending_interactions_block_recreation(self):
        with self.assertRaises(ValueError):
            require_idle({'jobs': [], 'questions': [{'status': 'pending'}]})


if __name__ == '__main__':
    unittest.main()
