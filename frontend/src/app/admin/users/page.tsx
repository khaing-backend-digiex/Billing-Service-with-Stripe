'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';
import { format } from 'date-fns';
import { Search, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import LoadingSpinner from '@/components/LoadingSpinner';
import { toast } from 'react-hot-toast';

export default function AdminUsersPage() {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 10;

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await api.get(`/users?page=${page}&limit=${limit}`);
      setUsers(res.data.data.users);
      setTotal(res.data.data.total);
    } catch (err) {
      console.error('Failed to load users', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, [page]);

  const handleDelete = async (id: string) => {
    if (!window.confirm('Are you sure you want to delete this user?')) return;
    try {
      await api.delete(`/users/${id}`);
      fetchUsers();
    } catch (err: any) {
      toast.error(err.response?.data?.message || 'Failed to delete user');
    }
  };

  const filteredUsers = users.filter(u => u.email.toLowerCase().includes(search.toLowerCase()) || u.name?.toLowerCase().includes(search.toLowerCase()));

  return (
    <div style={{ padding: '40px', maxWidth: '1000px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '32px' }}>
        <h1 className="h1">Users Management</h1>
      </div>

      <div className="card">
        <div style={{ marginBottom: '24px', position: 'relative' }}>
          <Search size={18} color="var(--text-muted)" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
          <input
            type="text"
            placeholder="Search users by email or name..."
            className="input"
            style={{ paddingLeft: '40px', maxWidth: '400px' }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {loading ? (
          <LoadingSpinner message="Loading users..." />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-secondary)', fontSize: '13px' }}>
                  <th style={{ padding: '12px 0', fontWeight: 500 }}>Email</th>
                  <th style={{ padding: '12px 0', fontWeight: 500 }}>Name</th>
                  <th style={{ padding: '12px 0', fontWeight: 500 }}>Roles</th>
                  <th style={{ padding: '12px 0', fontWeight: 500 }}>Joined</th>
                  <th style={{ padding: '12px 0', fontWeight: 500, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((user: any) => (
                  <tr key={user.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '16px 0', fontWeight: 500 }}>{user.email}</td>
                    <td style={{ padding: '16px 0' }}>{user.name || '—'}</td>
                    <td style={{ padding: '16px 0' }}>
                      {user.roles.map((r: string) => (
                        <span key={r} style={{ 
                          padding: '2px 8px', 
                          backgroundColor: r === 'admin' ? 'rgba(16, 163, 127, 0.1)' : 'var(--bg-tertiary)', 
                          color: r === 'admin' ? 'var(--accent)' : 'var(--text-primary)',
                          borderRadius: '4px',
                          fontSize: '12px',
                          marginRight: '4px'
                        }}>
                          {r}
                        </span>
                      ))}
                    </td>
                    <td style={{ padding: '16px 0', color: 'var(--text-secondary)' }}>
                      {format(new Date(user.createdAt), 'MMM d, yyyy')}
                    </td>
                    <td style={{ padding: '16px 0', textAlign: 'right' }}>
                      <button 
                        onClick={() => handleDelete(user.id)}
                        className="btn btn-danger"
                        style={{ padding: '6px', minWidth: 0 }}
                        title="Delete User"
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filteredUsers.length === 0 && (
              <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>No users found matching "{search}"</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 0', marginTop: '16px', borderTop: '1px solid var(--border)' }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
                Showing {total > 0 ? (page - 1) * limit + 1 : 0} to {Math.min(page * limit, total)} of {total} users
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  className="btn btn-secondary"
                  style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', opacity: page === 1 ? 0.5 : 1, cursor: page === 1 ? 'not-allowed' : 'pointer' }}
                  disabled={page === 1}
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                >
                  <ChevronLeft size={16} style={{ marginRight: '4px' }} /> Prev
                </button>
                <button
                  className="btn btn-secondary"
                  style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', opacity: page * limit >= total ? 0.5 : 1, cursor: page * limit >= total ? 'not-allowed' : 'pointer' }}
                  disabled={page * limit >= total}
                  onClick={() => setPage(p => p + 1)}
                >
                  Next <ChevronRight size={16} style={{ marginLeft: '4px' }} />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
